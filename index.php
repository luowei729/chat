<?php
// chat.php - 临时Web聊天应用（支持语音和视频消息）
date_default_timezone_set('Asia/Shanghai'); // 统一使用北京时间
// ===================== 配置区域 =====================
// 已加入 Cloudflare Turnstile 验证：未验证浏览器访问首页/房间前需要先验证，验证通过后写入 Cookie。

// 启动会话并设置更长的生命周期
session_start([
    'cookie_lifetime' => 86400, // 24小时
    'cookie_secure' => true,   // 兼容HTTP
    'cookie_httponly' => true,
    'use_strict_mode' => true
]);

// 设置字符编码
header('Content-Type: text/html; charset=utf-8');

// 定义存储目录
define('CHAT_DIR', 'chat_data/');
define('UPLOAD_DIR', 'uploads/');
define('DELETED_FILE', CHAT_DIR . 'deleted_chats.json');
define('EXPIRY_FILE', CHAT_DIR . 'chat_expiry.json');
define('RTC_DIR', CHAT_DIR); // 语音通话信令存储目录（与聊天同目录）


// ===================== Turnstile 验证配置 =====================
// 1. 到 Cloudflare Turnstile 后台创建站点，获取 Site Key 和 Secret Key。
// 2. 将下面两个值替换成你自己的 Key。
// 3. TURNSTILE_COOKIE_SECRET 必须改成一串随机密钥，用于签名 Cookie，防止被伪造。
define('TURNSTILE_ENABLED', true);
define('TURNSTILE_SITE_KEY', '0x4AAAAAAA5E6zs-gl8lJqfF');
define('TURNSTILE_SECRET_KEY', '0x4AAAAAAA5E66m7DXyEmmL68cbq_KbJI4E');
define('TURNSTILE_COOKIE_NAME', 'chat_turnstile_verified');
define('TURNSTILE_COOKIE_DAYS', 30); // 同一浏览器验证通过后，30天内不用重复验证
define('TURNSTILE_COOKIE_SECRET', '9f3b7c2a6e1d4a8b0c5f9jkhd43jh4j6h5jk6h43jkg5h7g2lkjg6lkj56g2kj35g75jk78fg2kg72kjg75kj2g567');
// 调试开关：开启后验证失败会显示 Cloudflare 返回的 error-codes，方便定位；正式使用也可以保持 true，不会显示 Secret Key。
define('TURNSTILE_DEBUG_ERROR', true);

// ========== App 免验证 Token（供 Android/iOS/HarmonyOS App 壳使用） ==========
// 原因：Cloudflare Turnstile 在 App 内嵌 WebView 中可能加载失败，App 通过 Header 或 URL 携带此 Token 时跳过人机验证
// 生成方式：openssl rand -hex 32
// 使用：请求头 X-App-Token: <值> 或 URL ?app_token=<值>，均可
// 安全：此 Token 等同于 Turnstile 验证通过，请妥善保管，泄露后请立即更换
define('APP_TOKEN', 'c2a8f1d9e4b603a7f8e2c9d1b6a4e0f8735d2c1e9a8b7f0d6c3e2a1b9f8d7e6c5a2b4');

// 创建必要的目录
if (!file_exists(CHAT_DIR)) {
    mkdir(CHAT_DIR, 0777, true);
}
if (!file_exists(UPLOAD_DIR)) {
    mkdir(UPLOAD_DIR, 0777, true);
}

// 初始化已删除聊天记录文件
if (!file_exists(DELETED_FILE)) {
    file_put_contents(DELETED_FILE, json_encode([]));
}

// 初始化聊天过期记录文件
if (!file_exists(EXPIRY_FILE)) {
    file_put_contents(EXPIRY_FILE, json_encode([]));
}

// 获取已删除聊天列表
function getDeletedChats() {
    if (file_exists(DELETED_FILE)) {
        $deleted = json_decode(file_get_contents(DELETED_FILE), true);
        return $deleted ?: [];
    }
    return [];
}

// 获取聊天过期信息
function getChatExpiry() {
    if (file_exists(EXPIRY_FILE)) {
        $expiry = json_decode(file_get_contents(EXPIRY_FILE), true);
        return $expiry ?: [];
    }
    return [];
}

// 设置聊天过期时间（7天后）
function setChatExpiry($chat_id) {
    $expiry_data = getChatExpiry();
    $expiry_data[$chat_id] = time() + (7 * 24 * 60 * 60); // 7天后的时间戳
    file_put_contents(EXPIRY_FILE, json_encode($expiry_data, JSON_PRETTY_PRINT));
}

// ========== 实时语音聊天信令（WebRTC 文件轮询，无需额外服务） ==========
function rtcFile($chat_id){ return CHAT_DIR . $chat_id . '_rtc.json'; }
function rtcLoad($chat_id){
    $f = rtcFile($chat_id);
    if(!file_exists($f)) return ['peers'=>[],'signals'=>[]];
    $fp=@fopen($f,'r');
    if(!$fp) return ['peers'=>[],'signals'=>[]];
    if(flock($fp, LOCK_SH)){
        $c=stream_get_contents($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
        $d=json_decode($c,true);
        return is_array($d)?$d:['peers'=>[],'signals'=>[]];
    }
    fclose($fp);
    $d=json_decode(@file_get_contents($f),true);
    return is_array($d)?$d:['peers'=>[],'signals'=>[]];
}
function rtcSave($chat_id,$data){
    $f=rtcFile($chat_id);
    $fp=@fopen($f,'c+');
    if(!$fp){ @file_put_contents($f, json_encode($data, JSON_PRETTY_PRINT)); return; }
    if(flock($fp, LOCK_EX)){
        ftruncate($fp,0); rewind($fp);
        fwrite($fp, json_encode($data, JSON_PRETTY_PRINT));
        fflush($fp); flock($fp, LOCK_UN);
    } else {
        @file_put_contents($f, json_encode($data, JSON_PRETTY_PRINT), LOCK_EX);
    }
    fclose($fp);
}
function rtcTransaction($chat_id, $cb){
    $f=rtcFile($chat_id);
    $fp=@fopen($f,'c+');
    if(!$fp){
        $data=['peers'=>[],'signals'=>[]];
        $data=$cb($data);
        @file_put_contents($f, json_encode($data, JSON_PRETTY_PRINT), LOCK_EX);
        return $data;
    }
    flock($fp, LOCK_EX);
    $c=stream_get_contents($fp);
    $data=$c?json_decode($c,true):null;
    if(!is_array($data)) $data=['peers'=>[],'signals'=>[]];
    $data=$cb($data);
    ftruncate($fp,0); rewind($fp);
    fwrite($fp, json_encode($data, JSON_PRETTY_PRINT));
    fflush($fp); flock($fp, LOCK_UN);
    fclose($fp);
    return $data;
}
function handleRtcSignal(){
    global $chat_id, $user_id;
    $type = isset($_POST['rtc_type'])?trim($_POST['rtc_type']):'';
    $payload = isset($_POST['payload'])?$_POST['payload']:'';
    $target = isset($_POST['target'])?trim($_POST['target']):'';
    $now = time();
    $resp = null;
    rtcTransaction($chat_id, function($data) use ($type,$payload,$target,$user_id,$now,&$resp){
        foreach($data['peers'] as $uid=>$info){ if($now - $info['ts'] > 60) unset($data['peers'][$uid]); }
        $data['signals'] = array_values(array_filter($data['signals'], function($s) use($now){ return $now - $s['ts'] < 30; }));
        if($type==='join'){
            $existingMuted = isset($data['peers'][$user_id]['muted']) ? (bool)$data['peers'][$user_id]['muted'] : false;
            $data['peers'][$user_id]=['ts'=>$now,'name'=>'用户'.substr($user_id,-6),'muted'=>$existingMuted];
            $resp=['status'=>'success','peers'=>$data['peers'],'user_id'=>$user_id];
            return $data;
        }
        if($type==='leave'){
            unset($data['peers'][$user_id]);
            $data['signals'][]=['from'=>$user_id,'to'=>'','type'=>'leave','payload'=>'','ts'=>$now];
            $resp=['status'=>'success'];
            return $data;
        }
        if($type==='heartbeat'){
            if(isset($data['peers'][$user_id])) $data['peers'][$user_id]['ts']=$now;
            else $data['peers'][$user_id]=['ts'=>$now,'name'=>'用户'.substr($user_id,-6),'muted'=>false];
            $resp=['status'=>'success','peers'=>$data['peers']];
            return $data;
        }
        if($type==='mute'){
            $muted=false;
            if($payload!==''){
                $j=json_decode($payload,true);
                if(is_array($j) && isset($j['muted'])) $muted=(bool)$j['muted'];
                elseif($payload==='1' || $payload==='true' || $payload==='"true"') $muted=true;
            }
            if(isset($data['peers'][$user_id])){ $data['peers'][$user_id]['muted']=$muted; $data['peers'][$user_id]['ts']=$now; }
            else $data['peers'][$user_id]=['ts'=>$now,'name'=>'用户'.substr($user_id,-6),'muted'=>$muted];
            $resp=['status'=>'success','peers'=>$data['peers']];
            return $data;
        }
        if(in_array($type,['offer','answer','ice'])){
            if($target==='' && $type!=='leave'){ $resp=['status'=>'error','message'=>'missing target']; return $data; }
            $data['signals'][]=['from'=>$user_id,'to'=>$target,'type'=>$type,'payload'=>$payload,'ts'=>$now];
            if(isset($data['peers'][$user_id])) $data['peers'][$user_id]['ts']=$now;
            $resp=['status'=>'success'];
            return $data;
        }
        $resp=['status'=>'error','message'=>'unknown rtc_type'];
        return $data;
    });
    echo json_encode($resp ?: ['status'=>'error','message'=>'unknown']);
}
function handleRtcPoll(){
    global $chat_id, $user_id;
    $now = time();
    $resp = null;
    rtcTransaction($chat_id, function($data) use ($user_id,$now,&$resp){
        foreach($data['peers'] as $uid=>$info){ if($now - $info['ts'] > 60) unset($data['peers'][$uid]); }
        $data['signals'] = array_values(array_filter($data['signals'], function($s) use($now){ return $now - $s['ts'] < 30; }));
        $mine=[];
        foreach($data['signals'] as $s){
            if($s['from']!==$user_id && ($s['to']==='' || $s['to']===$user_id)) $mine[]=$s;
        }
        $newSignals=[];
        foreach($data['signals'] as $s){
            $isPrivate=($s['to']!=='' && $s['to']===$user_id);
            if($isPrivate) continue;
            $newSignals[]=$s;
        }
        $data['signals']=$newSignals;
        if(isset($data['peers'][$user_id])) $data['peers'][$user_id]['ts']=$now;
        $resp=['status'=>'success','peers'=>$data['peers'],'signals'=>$mine,'user_id'=>$user_id];
        return $data;
    });
    echo json_encode($resp);
}

// 获取聊天剩余时间
function getChatRemainingTime($chat_id) {
    $expiry_data = getChatExpiry();
    if (isset($expiry_data[$chat_id])) {
        $remaining = $expiry_data[$chat_id] - time();
        return max(0, $remaining); // 返回剩余秒数，最小为0
    }
    return 7 * 24 * 60 * 60; // 如果没有记录，默认返回7天
}

// 检查聊天是否过期
function isChatExpired($chat_id) {
    $expiry_data = getChatExpiry();
    if (!isset($expiry_data[$chat_id])) {
        return false; // 没有过期记录，不算过期
    }
    return time() >= $expiry_data[$chat_id];
}

// 清理超过7天的消息（只删消息，不删聊天室）
function cleanupExpiredChats() {
    $cutoff_time = time() - (7 * 24 * 60 * 60); // 7天前的时间戳
    
    if (!is_dir(CHAT_DIR)) return;
    
    $files = glob(CHAT_DIR . '*.json');
    if (!$files) return;
    
    foreach ($files as $chat_file) {
        // 跳过元数据文件
        $basename = basename($chat_file);
        if ($basename === 'deleted_chats.json' || $basename === 'chat_expiry.json') {
            continue;
        }
        
        $chat_data = json_decode(file_get_contents($chat_file), true);
        if (!isset($chat_data['messages'])) continue;
        
        $original_count = count($chat_data['messages']);
        $filtered = [];
        
        foreach ($chat_data['messages'] as $message) {
            if ($message['timestamp'] < $cutoff_time) {
                // 删除超期7天的附件文件
                if (isset($message['type']) && $message['type'] !== 'text' && isset($message['content'])) {
                    $file_path = UPLOAD_DIR . $message['content'];
                    if (file_exists($file_path)) {
                        unlink($file_path);
                    }
                }
                // 消息本身不保留
            } else {
                $filtered[] = $message;
            }
        }
        
        if (count($filtered) < $original_count) {
            $chat_data['messages'] = $filtered;
            file_put_contents($chat_file, json_encode($chat_data, JSON_PRETTY_PRINT));
        }
    }
}

// 标记聊天为已删除
function markChatAsDeleted($chat_id) {
    $deleted_chats = getDeletedChats();
    $deleted_chats[$chat_id] = time();
    file_put_contents(DELETED_FILE, json_encode($deleted_chats, JSON_PRETTY_PRINT));
}

// 完全删除聊天（包括所有文件）
function deleteChatCompletely($chat_id) {
    $chat_file = CHAT_DIR . $chat_id . '.json';
    $creator_file = CHAT_DIR . $chat_id . '_creator.txt';
    
    // 读取聊天数据，删除上传的文件
    if (file_exists($chat_file)) {
        $chat_data = json_decode(file_get_contents($chat_file), true);
        $messages = isset($chat_data['messages']) ? $chat_data['messages'] : [];
        foreach ($messages as $message) {
            if ($message['type'] !== 'text') {
                $file_path = UPLOAD_DIR . $message['content'];
                if (file_exists($file_path)) {
                    unlink($file_path);
                }
            }
        }
        unlink($chat_file);
    }
    
    // 删除创建者备份文件
    if (file_exists($creator_file)) {
        unlink($creator_file);
    }
    
    // 标记为已删除
    markChatAsDeleted($chat_id);
    
    // 从过期记录中移除
    $expiry_data = getChatExpiry();
    if (isset($expiry_data[$chat_id])) {
        unset($expiry_data[$chat_id]);
        file_put_contents(EXPIRY_FILE, json_encode($expiry_data, JSON_PRETTY_PRINT));
    }
}

// 生成唯一聊天ID（避免使用已删除的ID）
function generateUniqueChatId() {
    $deleted_chats = getDeletedChats();
    $max_attempts = 10; // 防止无限循环
    
    for ($i = 0; $i < $max_attempts; $i++) {
        $new_id = uniqid('', true);
        if (!isset($deleted_chats['chat_' . $new_id])) {
            return $new_id;
        }
    }
    
    // 如果多次尝试都失败，使用更复杂的方法生成ID
    return uniqid('', true) . '_' . mt_rand(1000, 9999);
}


// ===================== Turnstile 验证函数 =====================
function isHttpsRequest() {
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');
}

function currentFullUrl() {
    $proto = isHttpsRequest() ? 'https' : 'http';
    $host = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : 'localhost';
    $uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
    return $proto . '://' . $host . $uri;
}

function base64UrlEncode($data) {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function base64UrlDecode($data) {
    $remainder = strlen($data) % 4;
    if ($remainder) {
        $data .= str_repeat('=', 4 - $remainder);
    }
    return base64_decode(strtr($data, '-_', '+/'));
}

function turnstileUserAgentHash() {
    $ua = isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '';
    return substr(hash('sha256', $ua), 0, 24);
}

function buildTurnstileCookieValue($expires) {
    $payload = $expires . '|' . turnstileUserAgentHash();
    $sig = hash_hmac('sha256', $payload, TURNSTILE_COOKIE_SECRET);
    return base64UrlEncode($payload . '|' . $sig);
}

// App Token 检测：Header 优先，其次 URL 参数，其次 cookie（App 内携带）
// 原因：App WebView 可能被 Cloudflare 拦截，携带此 Token 视为已验证，直接跳过 Turnstile
function hasValidAppToken() {
    // 兼容不同服务器对 Header 的大小写/下划线处理
    $sent = '';
    if (!empty($_SERVER['HTTP_X_APP_TOKEN'])) $sent = trim($_SERVER['HTTP_X_APP_TOKEN']);
    elseif (!empty($_SERVER['HTTP_X_APP_TOKEN_LOWER'])) $sent = trim($_SERVER['HTTP_X_APP_TOKEN_LOWER']);
    elseif (function_exists('getallheaders')) {
        $hs = getallheaders();
        if ($hs) foreach ($hs as $k => $v) if (strtolower($k) === 'x-app-token') { $sent = trim($v); break; }
    }
    if ($sent === '' && !empty($_GET['app_token'])) $sent = trim($_GET['app_token']);
    if ($sent === '' && !empty($_POST['app_token'])) $sent = trim($_POST['app_token']);
    if ($sent === '' && !empty($_COOKIE['app_token'])) $sent = trim($_COOKIE['app_token']);
    if ($sent === '') return false;
    // 常量未配置时不启用白名单
    if (!defined('APP_TOKEN') || APP_TOKEN === '' || strpos(APP_TOKEN, '请') !== false) return false;
    // 使用 hash_equals 防时序攻击
    return hash_equals(APP_TOKEN, $sent);
}

function hasValidTurnstileCookie() {
    // App Token 视为已验证
    if (hasValidAppToken()) return true;
    if (!TURNSTILE_ENABLED) return true;
    if (empty($_COOKIE[TURNSTILE_COOKIE_NAME])) return false;

    $raw = base64UrlDecode($_COOKIE[TURNSTILE_COOKIE_NAME]);
    if (!$raw) return false;

    $parts = explode('|', $raw);
    if (count($parts) !== 3) return false;

    list($expires, $uaHash, $sig) = $parts;
    if (!ctype_digit((string)$expires) || time() > intval($expires)) return false;
    if (!hash_equals(turnstileUserAgentHash(), $uaHash)) return false;

    $payload = $expires . '|' . $uaHash;
    $expected = hash_hmac('sha256', $payload, TURNSTILE_COOKIE_SECRET);
    return hash_equals($expected, $sig);
}

function setTurnstileVerifiedCookie() {
    $expires = time() + (TURNSTILE_COOKIE_DAYS * 24 * 60 * 60);
    $value = buildTurnstileCookieValue($expires);

    if (PHP_VERSION_ID >= 70300) {
        setcookie(TURNSTILE_COOKIE_NAME, $value, [
            'expires' => $expires,
            'path' => '/',
            'secure' => isHttpsRequest(),
            'httponly' => true,
            'samesite' => 'Lax'
        ]);
    } else {
        setcookie(TURNSTILE_COOKIE_NAME, $value, $expires, '/', '', isHttpsRequest(), true);
    }

    $_COOKIE[TURNSTILE_COOKIE_NAME] = $value;
}

function verifyTurnstileToken($token, &$error = '') {
    // 统一 trim，避免复制 Key 时带空格/换行导致 Cloudflare 判定 Secret 无效。
    $siteKey = trim(TURNSTILE_SITE_KEY);
    $secretKey = trim(TURNSTILE_SECRET_KEY);
    $cookieSecret = trim(TURNSTILE_COOKIE_SECRET);
    $token = trim((string)$token);

    if ($siteKey === '' || strpos($siteKey, '请填写') !== false ||
        $secretKey === '' || strpos($secretKey, '请填写') !== false ||
        $cookieSecret === '' || strpos($cookieSecret, '请改成') !== false) {
        $error = 'Turnstile Key 还没有配置，请先在 PHP 文件顶部填写 Site Key、Secret Key 和 Cookie Secret。';
        return false;
    }

    if ($token === '') {
        $error = '请先完成人机验证';
        return false;
    }

    // Cloudflare Siteverify 支持 form-urlencoded 和 JSON；这里使用 JSON，避免部分服务器对表单编码/代理转发处理异常。
    $payload = json_encode([
        'secret' => $secretKey,
        'response' => $token,
        'remoteip' => isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : ''
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

    $result = false;
    $requestError = '';
    if (function_exists('curl_init')) {
        $ch = curl_init('https://challenges.cloudflare.com/turnstile/v0/siteverify');
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        curl_setopt($ch, CURLOPT_TIMEOUT, 12);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 8);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        $result = curl_exec($ch);
        if ($result === false) {
            $requestError = curl_error($ch);
        }
        curl_close($ch);
    } else {
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\n",
                'content' => $payload,
                'timeout' => 12
            ]
        ]);
        $result = @file_get_contents('https://challenges.cloudflare.com/turnstile/v0/siteverify', false, $context);
        if ($result === false) {
            $requestError = 'file_get_contents 请求失败，请检查服务器是否允许访问 challenges.cloudflare.com';
        }
    }

    if ($result === false || $result === '') {
        $error = '验证服务请求失败，请稍后重试' . (TURNSTILE_DEBUG_ERROR && $requestError ? '（' . $requestError . '）' : '');
        return false;
    }

    $json = json_decode($result, true);
    if (!is_array($json)) {
        $error = '验证服务返回异常，请稍后重试' . (TURNSTILE_DEBUG_ERROR ? '（返回内容不是 JSON）' : '');
        return false;
    }

    if (empty($json['success'])) {
        $codes = [];
        if (isset($json['error-codes']) && is_array($json['error-codes'])) {
            $codes = $json['error-codes'];
        }
        $debug = TURNSTILE_DEBUG_ERROR && !empty($codes) ? '（Cloudflare返回：' . implode(',', $codes) . '）' : '';

        if (in_array('missing-input-secret', $codes, true)) {
            $error = 'Turnstile Secret Key 没有提交到 Cloudflare，请检查 PHP 常量 TURNSTILE_SECRET_KEY 是否已填写' . $debug;
        } elseif (in_array('invalid-input-secret', $codes, true)) {
            $error = 'Turnstile Secret Key 无效。请确认：1）填的是 Secret Key 不是 Site Key；2）Site Key 和 Secret Key 来自同一个 Turnstile 小组件；3）服务器运行的是你刚修改的这个 PHP 文件' . $debug;
        } elseif (in_array('invalid-input-response', $codes, true) || in_array('missing-input-response', $codes, true)) {
            $error = '验证令牌无效或为空，请刷新页面后重试' . $debug;
        } elseif (in_array('timeout-or-duplicate', $codes, true)) {
            $error = '验证令牌已过期或已被使用，请刷新页面后重试' . $debug;
        } elseif (in_array('bad-request', $codes, true)) {
            $error = '验证请求格式错误，请检查服务器 PHP/cURL 环境' . $debug;
        } elseif (in_array('internal-error', $codes, true)) {
            $error = 'Cloudflare 验证服务内部错误，请稍后重试' . $debug;
        } else {
            $error = '验证失败，请刷新页面后重试' . $debug;
        }
        return false;
    }

    return true;
}

function safeReturnUrl($url) {
    if (empty($url)) return currentFullUrl();
    $currentHost = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '';
    $parts = parse_url($url);

    // 允许相对路径
    if ($parts !== false && !isset($parts['host']) && isset($parts['path'])) {
        return $url;
    }

    // 只允许跳回当前域名，避免开放重定向
    if ($parts !== false && isset($parts['host']) && strcasecmp($parts['host'], $currentHost) === 0) {
        return $url;
    }

    return currentFullUrl();
}

function showTurnstilePage($error = '') {
    $returnUrl = currentFullUrl();
    header('Content-Type: text/html; charset=utf-8');
    ?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>安全验证</title>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileApiLoaded" async defer></script>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; font-family:-apple-system,'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif; }
        html, body { width:100%; min-height:100%; }
        body {
            min-height:100vh; min-height:100svh; min-height:100dvh;
            background:linear-gradient(135deg,#1B3068 0%,#2D5BB5 100%);
            display:flex; align-items:center; justify-content:center;
            padding:calc(18px + env(safe-area-inset-top)) 18px calc(18px + env(safe-area-inset-bottom));
            color:#1a1f36;
        }
        .verify-card {
            width:min(100%,420px); background:#fff; border-radius:20px;
            box-shadow:0 20px 60px rgba(0,0,0,0.25);
            padding:38px 30px; text-align:center; overflow:hidden;
        }
        .logo { font-size:52px; margin-bottom:14px; }
        h1 { font-size:1.35rem; color:#1B3068; margin-bottom:8px; }
        .sub { color:#8892B0; font-size:0.8rem; line-height:1.5; margin-bottom:24px; }
        .turnstile-wrap { display:flex; justify-content:center; margin:18px 0 22px; min-height:65px; }
        .verify-status {
            width:100%; min-height:44px; border-radius:10px;
            background:#F4F7FF; color:#4F6EF7; border:1px solid #E3E8F7;
            display:flex; align-items:center; justify-content:center;
            font-size:0.9rem; font-weight:700;
        }
        .verify-btn {
            display:none;
            width:100%; min-height:44px; border:none; border-radius:10px;
            background:linear-gradient(135deg,#4F6EF7,#6b4fff); color:#fff;
            font-size:0.96rem; font-weight:700; cursor:pointer;
        }
        .verify-btn:active { transform:scale(.98); }
        .error {
            background:#fff0f0; color:#c62828; border:1px solid #ffcaca;
            border-radius:10px; padding:10px 12px; margin-bottom:16px;
            font-size:0.84rem; line-height:1.5; text-align:left;
        }
        .tip { margin-top:18px; font-size:0.76rem; color:#b0bcc8; line-height:1.5; }
        @media (max-width:380px) { .verify-card { padding:30px 18px; } h1 { font-size:1.22rem; } }
    </style>
</head>
<body>
    <div class="verify-card">
        <div class="logo">🔐</div>
        <h1>访问前安全验证</h1>
        <p class="sub">
         手机微信验证异常请使用其他浏览器打开<br>
         加载异常请切换联通/电信/移动/5G等网络访问
        </p>
        <?php if ($error): ?>
            <div class="error"><?php echo htmlspecialchars($error, ENT_QUOTES, 'UTF-8'); ?></div>
        <?php endif; ?>
        <form method="post" action="" id="turnstile-form">
            <input type="hidden" name="action" value="turnstile_verify">
            <input type="hidden" name="return_url" value="<?php echo htmlspecialchars($returnUrl, ENT_QUOTES, 'UTF-8'); ?>">
            <input type="hidden" name="cf-turnstile-response" id="cf-turnstile-response" value="">
            <div class="turnstile-wrap">
                <div id="turnstile-widget"></div>
            </div>
            <div class="verify-status" id="verify-status">正在加载验证模块...</div>
            <button class="verify-btn" id="verify-submit-btn" type="submit">验证并继续</button>
        </form>
        <div class="tip">拦截机器扫描/防御被AI分析<br>请确保浏览器允许 Cookie<br>否则每次访问都需要重新验证</div>
    </div>
    <script>
        let turnstileSubmitting = false;
        let turnstileLoaded = false;
        let turnstileRendered = false;

        function setVerifyStatus(text) {
            const el = document.getElementById('verify-status');
            if (el) el.textContent = text;
        }

        function submitTurnstileToken(token) {
            if (turnstileSubmitting) return;

            const tokenInput = document.getElementById('cf-turnstile-response');
            const form = document.getElementById('turnstile-form');
            if (!token || !tokenInput || !form) {
                setVerifyStatus('验证令牌为空，请重新验证');
                return;
            }

            tokenInput.value = token;
            turnstileSubmitting = true;
            setVerifyStatus('验证成功，正在自动进入...');

            const btn = document.getElementById('verify-submit-btn');
            if (btn) btn.disabled = true;

            setTimeout(function() {
                form.submit();
            }, 250);
        }

        function onTurnstileSuccess(token) {
            submitTurnstileToken(token);
        }

        function onTurnstileError(errorCode) {
            turnstileSubmitting = false;
            const tokenInput = document.getElementById('cf-turnstile-response');
            if (tokenInput) tokenInput.value = '';

            // 避免“模块还没加载出来就提示验证失败”：未渲染完成前不显示普通验证失败。
            if (!turnstileLoaded || !turnstileRendered) {
                setVerifyStatus('验证模块加载失败，请刷新页面或检查 Site Key/域名配置');
                return;
            }

            setVerifyStatus('验证失败，请刷新页面重试' + (errorCode ? '（' + errorCode + '）' : ''));
        }

        function onTurnstileExpired() {
            turnstileSubmitting = false;
            const tokenInput = document.getElementById('cf-turnstile-response');
            if (tokenInput) tokenInput.value = '';
            setVerifyStatus('验证已过期，正在重新加载...');
            if (window.turnstile) {
                try { window.turnstile.reset('#turnstile-widget'); } catch (e) {}
            }
        }

        function onTurnstileApiLoaded() {
            turnstileLoaded = true;
            setVerifyStatus('请完成安全验证，验证成功后自动进入...');

            if (!window.turnstile || turnstileRendered) return;
            turnstileRendered = true;
            try {
                window.turnstile.render('#turnstile-widget', {
                    sitekey: '<?php echo htmlspecialchars(trim(TURNSTILE_SITE_KEY), ENT_QUOTES, 'UTF-8'); ?>',
                    callback: onTurnstileSuccess,
                    'error-callback': onTurnstileError,
                    'expired-callback': onTurnstileExpired
                });
            } catch (e) {
                turnstileRendered = false;
                setVerifyStatus('验证模块初始化失败，请检查 Site Key 和绑定域名');
            }
        }

        // 防止用户/浏览器在没有 token 时误提交，导致后端直接提示失败。
        document.getElementById('turnstile-form').addEventListener('submit', function(e) {
            const tokenInput = document.getElementById('cf-turnstile-response');
            if (!tokenInput || !tokenInput.value) {
                e.preventDefault();
                setVerifyStatus('请先完成安全验证');
            }
        });

        // API 脚本被拦截、网络异常、Cloudflare 无法访问时，给出加载失败，而不是“验证失败”。
        setTimeout(function() {
            if (!turnstileLoaded && !turnstileSubmitting) {
                setVerifyStatus('验证模块加载超时，请刷新页面或检查网络');
            }
        }, 8000);
    </script>
    </script>
</body>
</html>
    <?php
}

function requireTurnstileVerified() {
    if (!TURNSTILE_ENABLED || hasValidTurnstileCookie()) return;

    if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'turnstile_verify') {
        $error = '';
        $token = isset($_POST['cf-turnstile-response']) ? $_POST['cf-turnstile-response'] : '';
        if (verifyTurnstileToken($token, $error)) {
            setTurnstileVerifiedCookie();
            $returnUrl = isset($_POST['return_url']) ? safeReturnUrl($_POST['return_url']) : currentFullUrl();
            header('Location: ' . $returnUrl);
            exit;
        }
        showTurnstilePage($error);
        exit;
    }

    showTurnstilePage();
    exit;
}

// 未验证浏览器访问首页、创建房间、输入房间、聊天页、AJAX接口前，都先进入 Turnstile。
requireTurnstileVerified();

// 执行过期聊天清理
cleanupExpiredChats();

// ===================== URL 路由 =====================
// 支持三种方式：/1  /index.php/1  ?join=1
// 优先级：PATH_INFO > REQUEST_URI解析 > GET参数
function resolveJoinId() {
    // 1. PHP PATH_INFO: /index.php/myid
    if (!empty($_SERVER['PATH_INFO'])) {
        $id = trim($_SERVER['PATH_INFO'], '/');
        if ($id !== '') return $id;
    }
    
    // 2. REQUEST_URI 路径解析: /myid 或 /subdir/myid
    $uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $script = $_SERVER['SCRIPT_NAME'];
    $scriptDir = rtrim(dirname($script), '/');
    
    if ($scriptDir !== '' && strpos($uri, $scriptDir) === 0) {
        $relative = substr($uri, strlen($scriptDir));
    } else {
        $relative = $uri;
    }
    $relative = trim($relative, '/');
    
    // 如果相对路径不是 index.php 本身，就当作 ID
    if ($relative !== '' && $relative !== 'index.php') {
        return $relative;
    }
    
    return null;
}

// 构建聊天室的访问 URL（使用路径风格）
function chatUrl($id) {
    $script = $_SERVER['SCRIPT_NAME'];
    $scriptDir = rtrim(dirname($script), '/');
    $proto = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') ? 'https' : 'http';
    $host  = $_SERVER['HTTP_HOST'];
    return $proto . '://' . $host . $scriptDir . '/' . $id;
}

$join_raw = resolveJoinId();

// 如果没有 ID，显示首页（输入/创建房间）
if (!$join_raw || empty(trim($join_raw))) {
    showHomePage();
    exit;
}

// 清洗 ID（允许字母数字下划线点连字符）
$join_id = preg_replace('/[^a-zA-Z0-9_.\-]/', '', $join_raw);
if (empty($join_id)) {
    showHomePage();
    exit;
}
$chat_id = 'chat_' . $join_id;

function showHomePage() {
    // 生成随机短 ID（6位字母数字）
    function randomShortId($len = 6) {
        $chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        $id = '';
        for ($i = 0; $i < $len; $i++) {
            $id .= $chars[random_int(0, strlen($chars) - 1)];
        }
        return $id;
    }
    $suggested = randomShortId();
    $proto = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') ? 'https' : 'http';
    $base  = $proto . '://' . $_SERVER['HTTP_HOST'];
    $script = $_SERVER['SCRIPT_NAME'];
    $scriptDir = rtrim(dirname($script), '/');
    header('Content-Type: text/html; charset=utf-8');
    ?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>公司内部文件安全传输</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🔐</text></svg>">
    <style>
        * { margin:0; padding:0; box-sizing:border-box; font-family:-apple-system,'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif; }
        html, body {
            width:100%;
            min-height:100%;
        }
        body {
            min-height:100vh;
            min-height:100svh;
            min-height:100dvh;
            background:linear-gradient(135deg,#1B3068 0%,#2D5BB5 100%);
            display:flex;
            align-items:center;
            justify-content:center;
            padding:calc(18px + env(safe-area-inset-top)) 18px calc(18px + env(safe-area-inset-bottom));
            overflow-x:hidden;
            overflow-y:auto;
        }
        .card {
            background:#fff; border-radius:20px;
            box-shadow:0 20px 60px rgba(0,0,0,0.25);
            width:min(100%,420px);
            max-width:420px;
            padding:40px 32px;
            text-align:center;
            overflow:hidden;
        }
        .logo { font-size:52px; margin-bottom:16px; }
        h1 { font-size:1.4rem; color:#1B3068; font-weight:700; margin-bottom:8px; }
        .sub { color:#8892B0; font-size:0.9rem; margin-bottom:32px; line-height:1.5; }
        .section-label { text-align:left; font-size:0.8rem; font-weight:600; color:#4F6EF7; margin-bottom:8px; letter-spacing:.04em; }
        .input-row {
            display:flex;
            gap:8px;
            margin-bottom:24px;
            width:100%;
            min-width:0;
        }
        .id-input {
            flex:1 1 auto;
            min-width:0;
            width:100%;
            padding:11px 14px; border:2px solid #E3E8F7; border-radius:10px;
            font-size:1rem; color:#1a1f36; outline:none; transition:border .2s;
        }
        .id-input:focus { border-color:#4F6EF7; }
        .btn {
            flex:0 0 auto;
            padding:11px 18px; border:none; border-radius:10px; font-size:0.95rem;
            font-weight:600; cursor:pointer; transition:background .15s, transform .1s; white-space:nowrap;
            min-height:44px;
        }
        .btn:active { transform:scale(.97); }
        .btn-primary { background:linear-gradient(135deg,#4F6EF7,#6b4fff); color:#fff; }
        .btn-primary:hover { background:linear-gradient(135deg,#3B55D9,#5a3ef0); }
        .btn-new { width:100%; padding:13px; background:#f0f4ff; color:#4F6EF7; border:2px dashed #c0ccf7; border-radius:10px; font-size:0.95rem; font-weight:600; cursor:pointer; transition:background .15s; margin-bottom:0; }
        .btn-new:hover { background:#e3eaff; }
        .divider { display:flex; align-items:center; gap:10px; margin:20px 0; color:#c0c8d8; font-size:0.82rem; }
        .divider::before,.divider::after { content:''; flex:1; height:1px; background:#E3E8F7; }
        .footer { margin-top:28px; color:#b0bcc8; font-size:0.78rem; }

        /* 手机窄屏优化：防止“进入”按钮把输入框挤出屏幕 */
        @media (max-width: 380px) {
            body {
                align-items:center;
                justify-content:center;
                padding:calc(14px + env(safe-area-inset-top)) 12px calc(14px + env(safe-area-inset-bottom));
            }
            .card { padding:30px 18px; border-radius:18px; }
            .logo { font-size:46px; margin-bottom:12px; }
            h1 { font-size:1.22rem; }
            .sub { font-size:0.84rem; margin-bottom:24px; }
            .input-row { flex-direction:column; gap:10px; margin-bottom:20px; }
            .btn-primary { width:100%; }
            .btn-new { padding:12px 10px; }
        }

        @media (max-width: 320px) {
            .card { padding:26px 14px; }
            h1 { font-size:1.12rem; }
            .id-input, .btn, .btn-new { font-size:0.9rem; }
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">🔐</div>
        <h1>公司内部文件安全传输</h1>
        <p class="sub">输入房间 ID 直接进入，或创建一个新房间</p>

        <div class="section-label">进入指定房间</div>
        <div class="input-row">
            <input class="id-input" id="room-input" type="text" placeholder="输入房间 ID，如 1、abc…" maxlength="40"
                   value="" autocomplete="off" spellcheck="false">
            <button class="btn btn-primary" onclick="goToRoom()">进入</button>
        </div>

        <div class="divider">或者</div>

        <button class="btn-new" onclick="createRoom()">✚ 随机创建新房间</button>

        <div class="footer">消息保留7天后自动清理</div>
    </div>

    <script>
        const base = '<?php echo $base . $scriptDir; ?>';
        const suggested = '<?php echo $suggested; ?>';

        function goToRoom() {
            const id = document.getElementById('room-input').value.trim().replace(/[^a-zA-Z0-9_.\-]/g, '');
            if (!id) { document.getElementById('room-input').focus(); return; }
            window.location.href = base + '/' + id;
        }

        function createRoom() {
            window.location.href = base + '/' + suggested;
        }

        // 回车触发进入
        document.getElementById('room-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') goToRoom();
        });
    </script>
</body>
</html>
    <?php
}

// ID 永久有效，不再检查已删除或过期状态

// 使用更可靠的方法存储聊天ID
$_SESSION['chat_id'] = $chat_id;

// 为用户生成唯一标识符 - 使用更持久的方法
if (!isset($_SESSION['user_id'])) {
    // 尝试从cookie获取用户ID
    if (isset($_COOKIE['chat_user_id'])) {
        $_SESSION['user_id'] = $_COOKIE['chat_user_id'];
    } else {
        $_SESSION['user_id'] = 'user_' . substr(uniqid('', true), -8);
        // 同时存入cookie作为备份
        setcookie('chat_user_id', $_SESSION['user_id'], time() + 86400 * 30, '/');
    }
}

$user_id = $_SESSION['user_id'];
$chat_file = CHAT_DIR . $chat_id . '.json';

// 检查是否为创建者 - 使用更可靠的方法
$is_creator = false;
if (!file_exists($chat_file)) {
    // 如果聊天文件不存在，创建它并将当前用户标记为创建者
    file_put_contents($chat_file, json_encode([
        'creator_id' => $user_id,
        'messages' => []
    ]));
    $is_creator = true;
    
    // 将创建者信息存储在独立文件中作为备份
    $creator_file = CHAT_DIR . $chat_id . '_creator.txt';
    file_put_contents($creator_file, $user_id);
    
    // 设置聊天过期时间（7天后）
    setChatExpiry($chat_id);
} else {
    // 检查聊天文件中的创建者信息
    $chat_data = json_decode(file_get_contents($chat_file), true);
    
    // 如果聊天文件没有创建者信息，检查备份文件
    if (isset($chat_data['creator_id'])) {
        $is_creator = ($chat_data['creator_id'] === $user_id);
    } else {
        // 检查备份的创建者文件
        $creator_file = CHAT_DIR . $chat_id . '_creator.txt';
        if (file_exists($creator_file)) {
            $saved_creator_id = file_get_contents($creator_file);
            $is_creator = ($saved_creator_id === $user_id);
            
            // 更新聊天文件中的创建者信息
            $chat_data['creator_id'] = $saved_creator_id;
            file_put_contents($chat_file, json_encode($chat_data, JSON_PRETTY_PRINT));
        } else {
            // 如果没有创建者信息，默认为不是创建者
            $is_creator = false;
        }
    }
    
    // 如果聊天没有过期时间记录，添加一个（兼容旧聊天）
    $expiry_data = getChatExpiry();
    if (!isset($expiry_data[$chat_id])) {
        setChatExpiry($chat_id);
    }
}

// 将创建者状态存储在会话中
$_SESSION['is_creator'] = $is_creator;

// 初始化聊天文件
if (!file_exists($chat_file)) {
    file_put_contents($chat_file, json_encode([
        'creator_id' => $user_id,
        'messages' => []
    ]));
}

// 获取聊天剩余时间（用于显示倒计时）
$remaining_time = getChatRemainingTime($chat_id);

// 处理表单提交
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (isset($_POST['action'])) {
        switch ($_POST['action']) {
            case 'send_message':
                sendMessage();
                break;
            case 'delete_chat':
                deleteChat();
                break;
            case 'delete_message':
                deleteMessage();
                break;
            case 'upload_file':
                uploadFile();
                break;
            case 'upload_voice':
                uploadVoice();
                break;
            case 'check_chat_exists':
                checkChatExists();
                break;
            case 'get_messages':
                getMessagesAjax();
                break;
            case 'check_creator_status':
                checkCreatorStatus();
                break;
            case 'get_remaining_time':
                getRemainingTime();
                break;
            case 'rtc_signal':
                handleRtcSignal();
                break;
            case 'rtc_poll':
                handleRtcPoll();
                break;
        }
    }
    exit;
}

// 显示聊天已删除页面
function displayDeletedChatPage() {
    ?>
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>文件不存在</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            }
            
            body {
                background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
                color: #333;
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 20px;
            }
            
            .deleted-container {
                width: 100%;
                max-width: 500px;
                background: white;
                border-radius: 12px;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
                padding: 40px 30px;
                text-align: center;
            }
            
            .deleted-icon {
                font-size: 64px;
                margin-bottom: 20px;
                color: #e74c3c;
            }
            
            .deleted-title {
                font-size: 1.5rem;
                font-weight: 600;
                margin-bottom: 15px;
                color: #c62828;
            }
            
            .deleted-message {
                font-size: 1rem;
                margin-bottom: 25px;
                color: #666;
                line-height: 1.5;
            }
        </style>
    </head>
    <body>
        <div class="deleted-container">
            <div class="deleted-icon">🗑️</div>
            <h1 class="deleted-title">分享的文件已失效</h1>
            <p class="deleted-message"></p>
        </div>
    </body>
    </html>
    <?php
}

// 获取剩余时间
function getRemainingTime() {
    global $chat_id;
    $remaining = getChatRemainingTime($chat_id);
    echo json_encode(['remaining_time' => $remaining]);
}

// 检查聊天是否存在 - ID 永久有效，始终返回 true
function checkChatExists() {
    echo json_encode(['exists' => true]);
}

// 检查创建者状态
function checkCreatorStatus() {
    global $chat_id, $user_id, $is_creator;
    
    // 重新检查创建者状态
    $chat_file = CHAT_DIR . $chat_id . '.json';
    if (file_exists($chat_file)) {
        $chat_data = json_decode(file_get_contents($chat_file), true);
        $current_creator = isset($chat_data['creator_id']) ? $chat_data['creator_id'] : '';
        
        // 检查备份文件
        if (empty($current_creator)) {
            $creator_file = CHAT_DIR . $chat_id . '_creator.txt';
            if (file_exists($creator_file)) {
                $current_creator = file_get_contents($creator_file);
            }
        }
        
        $is_creator_now = ($current_creator === $user_id);
        echo json_encode(['is_creator' => $is_creator_now]);
    } else {
        echo json_encode(['is_creator' => false]);
    }
}

// 获取聊天消息 - 用于AJAX请求
function getMessagesAjax() {
    global $chat_file, $user_id;
    
    if (file_exists($chat_file)) {
        $chat_data = json_decode(file_get_contents($chat_file), true);
        $messages = isset($chat_data['messages']) ? $chat_data['messages'] : [];
        
        // 为每条消息添加是否为当前用户发送的标识
        foreach ($messages as &$message) {
            $message['is_self'] = ($message['sender_id'] === $user_id);
        }
        
        echo json_encode(['status' => 'success', 'messages' => $messages]);
    } else {
        echo json_encode(['status' => 'error', 'message' => '聊天文件不存在']);
    }
}

// 获取聊天消息 - 用于初始页面加载
function getMessages() {
    global $chat_file;
    if (file_exists($chat_file)) {
        $chat_data = json_decode(file_get_contents($chat_file), true);
        return isset($chat_data['messages']) ? $chat_data['messages'] : [];
    }
    return [];
}

// 发送消息
function sendMessage() {
    global $chat_file, $chat_id, $user_id;
    
    $message = [
        'id' => uniqid(),
        'type' => 'text',
        'content' => htmlspecialchars($_POST['message']),
        'timestamp' => time(),
        'sender_id' => $user_id,
        'sender_name' => '用户' . substr($user_id, -6)
    ];
    
    $chat_data = json_decode(file_get_contents($chat_file), true);
    $messages = isset($chat_data['messages']) ? $chat_data['messages'] : [];
    $messages[] = $message;
    $chat_data['messages'] = $messages;
    
    file_put_contents($chat_file, json_encode($chat_data, JSON_PRETTY_PRINT));
    
    echo json_encode(['status' => 'success', 'message' => $message]);
}

// 上传文件
function uploadFile() {
    global $chat_file, $chat_id, $user_id;
    
    if (isset($_FILES['file']) && $_FILES['file']['error'] === UPLOAD_ERR_OK) {
        $file = $_FILES['file'];
        
        // 验证文件大小 - 限制
        $max_size = 10000 * 1024 * 1024; // 10GB
        
        if ($file['size'] > $max_size) {
            echo json_encode(['status' => 'error', 'message' => '文件过大 (最大100MB)']);
            return;
        }
        
        // 生成唯一文件名
        $file_ext = pathinfo($file['name'], PATHINFO_EXTENSION);
        $file_name = uniqid() . '.' . $file_ext;
        $file_path = UPLOAD_DIR . $file_name;
        
        if (move_uploaded_file($file['tmp_name'], $file_path)) {
            // 判断文件类型
            $file_type = $file['type'];
            if (strpos($file_type, 'video/') === 0) {
                $message_type = 'video';
            } elseif (strpos($file_type, 'image/') === 0) {
                $message_type = 'image';
            } else {
                $message_type = $file_type;
            }
            
            $message = [
                'id' => uniqid(),
                'type' => $message_type,
                'content' => $file_name,
                'original_name' => $file['name'],
                'timestamp' => time(),
                'sender_id' => $user_id,
                'sender_name' => '用户' . substr($user_id, -6)
            ];
            
            $chat_data = json_decode(file_get_contents($chat_file), true);
            $messages = isset($chat_data['messages']) ? $chat_data['messages'] : [];
            $messages[] = $message;
            $chat_data['messages'] = $messages;
            
            file_put_contents($chat_file, json_encode($chat_data, JSON_PRETTY_PRINT));
            
            echo json_encode(['status' => 'success', 'message' => $message]);
        } else {
            echo json_encode(['status' => 'error', 'message' => '文件上传失败']);
        }
    } else {
        echo json_encode(['status' => 'error', 'message' => '文件上传错误']);
    }
}

// 上传语音消息
function uploadVoice() {
    global $chat_file, $chat_id, $user_id;
    
    if (isset($_FILES['voice']) && $_FILES['voice']['error'] === UPLOAD_ERR_OK) {
        $voice = $_FILES['voice'];
        
        // 验证文件大小 - 10MB限制
        $max_size = 10 * 1024 * 1024; // 10MB
        
        if ($voice['size'] > $max_size) {
            echo json_encode(['status' => 'error', 'message' => '语音文件过大 (最大10MB)']);
            return;
        }
        
        // 验证文件类型。录音多数浏览器实际生成 webm/ogg/mp4，不要强制伪装成 wav，否则会导致播放失败。
        $mime = !empty($voice['type']) ? strtolower($voice['type']) : '';
        if ($mime === '' && function_exists('mime_content_type')) {
            $detected = mime_content_type($voice['tmp_name']);
            if ($detected) $mime = strtolower($detected);
        }
        $allowed_types = [
            'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm',
            'audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp3',
            'audio/mp4', 'audio/aac', 'audio/x-m4a', 'video/webm', 'video/mp4', 'video/quicktime'
        ];
        if ($mime !== '' && strpos($mime, 'audio/') !== 0 && !in_array($mime, ['video/webm', 'video/mp4', 'video/quicktime'])) {
            echo json_encode(['status' => 'error', 'message' => '不支持的音频格式']);
            return;
        }
        if ($mime !== '' && !in_array($mime, $allowed_types) && strpos($mime, 'audio/') !== 0) {
            echo json_encode(['status' => 'error', 'message' => '不支持的音频格式']);
            return;
        }

        // 根据真实 MIME/原始文件名保存扩展名，避免 webm 内容被保存为 .wav 导致浏览器无法播放。
        $ext_map = [
            'audio/webm' => 'webm', 'video/webm' => 'webm',
            'audio/ogg' => 'ogg', 'audio/opus' => 'ogg',
            'audio/mp4' => 'm4a', 'audio/x-m4a' => 'm4a', 'audio/aac' => 'aac',
            'video/mp4' => 'm4a', 'video/quicktime' => 'm4a',
            'audio/mpeg' => 'mp3', 'audio/mp3' => 'mp3',
            'audio/wav' => 'wav', 'audio/x-wav' => 'wav', 'audio/wave' => 'wav'
        ];
        $file_ext = isset($ext_map[$mime]) ? $ext_map[$mime] : strtolower(pathinfo($voice['name'], PATHINFO_EXTENSION));
        if (!preg_match('/^[a-z0-9]{2,5}$/', $file_ext)) {
            $file_ext = 'webm';
        }
        $file_name = uniqid() . '.' . $file_ext;
        $file_path = UPLOAD_DIR . $file_name;

        if (move_uploaded_file($voice['tmp_name'], $file_path)) {
            $message = [
                'id' => uniqid(),
                'type' => 'voice',
                'content' => $file_name,
                'original_name' => isset($voice['name']) && $voice['name'] ? htmlspecialchars($voice['name']) : ('语音消息.' . $file_ext),
                'mime_type' => $mime,
                'timestamp' => time(),
                'sender_id' => $user_id,
                'sender_name' => '用户' . substr($user_id, -6),
                'duration' => isset($_POST['duration']) ? intval($_POST['duration']) : 0
            ];
            
            $chat_data = json_decode(file_get_contents($chat_file), true);
            $messages = isset($chat_data['messages']) ? $chat_data['messages'] : [];
            $messages[] = $message;
            $chat_data['messages'] = $messages;
            
            file_put_contents($chat_file, json_encode($chat_data, JSON_PRETTY_PRINT));
            
            echo json_encode(['status' => 'success', 'message' => $message]);
        } else {
            echo json_encode(['status' => 'error', 'message' => '语音上传失败']);
        }
    } else {
        echo json_encode(['status' => 'error', 'message' => '语音上传错误']);
    }
}

// 删除全部聊天消息（任何访客均可操作，聊天室 ID 保持永久有效）
function deleteChat() {
    global $chat_id;
    
    $chat_file = CHAT_DIR . $chat_id . '.json';
    
    if (file_exists($chat_file)) {
        $chat_data = json_decode(file_get_contents($chat_file), true);
        $messages = isset($chat_data['messages']) ? $chat_data['messages'] : [];
        
        // 删除所有消息的附件文件
        foreach ($messages as $message) {
            if (isset($message['type']) && $message['type'] !== 'text' && isset($message['content'])) {
                $file_path = UPLOAD_DIR . $message['content'];
                if (file_exists($file_path)) {
                    unlink($file_path);
                }
            }
        }
        
        // 清空消息列表，保留聊天文件（ID 永久有效）
        $chat_data['messages'] = [];
        file_put_contents($chat_file, json_encode($chat_data, JSON_PRETTY_PRINT));
        
        echo json_encode(['status' => 'success', 'message' => '聊天记录已清空']);
    } else {
        // 聊天文件不存在时自动创建（首次访问即清空场景）
        echo json_encode(['status' => 'success', 'message' => '聊天记录已清空']);
    }
}

// 删除单条消息（任何访客均可操作）
function deleteMessage() {
    global $chat_id;
    
    $message_id = isset($_POST['message_id']) ? trim($_POST['message_id']) : '';
    if (empty($message_id)) {
        echo json_encode(['status' => 'error', 'message' => '缺少消息ID']);
        return;
    }
    
    $chat_file = CHAT_DIR . $chat_id . '.json';
    
    if (!file_exists($chat_file)) {
        echo json_encode(['status' => 'error', 'message' => '聊天文件不存在']);
        return;
    }
    
    $chat_data = json_decode(file_get_contents($chat_file), true);
    $messages = isset($chat_data['messages']) ? $chat_data['messages'] : [];
    
    $new_messages = [];
    $deleted = false;
    
    foreach ($messages as $message) {
        if ($message['id'] === $message_id) {
            // 删除消息的附件文件
            if (isset($message['type']) && $message['type'] !== 'text' && isset($message['content'])) {
                $file_path = UPLOAD_DIR . $message['content'];
                if (file_exists($file_path)) {
                    unlink($file_path);
                }
            }
            $deleted = true;
        } else {
            $new_messages[] = $message;
        }
    }
    
    if ($deleted) {
        $chat_data['messages'] = $new_messages;
        file_put_contents($chat_file, json_encode($chat_data, JSON_PRETTY_PRINT));
        echo json_encode(['status' => 'success']);
    } else {
        echo json_encode(['status' => 'error', 'message' => '消息不存在']);
    }
}

// 获取消息用于显示
$messages = getMessages();
// 生成分享链接 ID 和完整 URL
$share_id = substr($chat_id, 5);
$share_url = chatUrl($share_id);
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>公司内部文件安全传输</title>
    <style>
        /* ===== 基础重置 ===== */
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: -apple-system, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', sans-serif;
            -webkit-tap-highlight-color: transparent;
        }

        :root {
            --primary: #4F6EF7;
            --primary-dark: #3B55D9;
            --self-bubble: linear-gradient(135deg, #4f7cf7 0%, #6b4fff 100%);
            --other-bubble: #ffffff;
            --bg: #EEF1FB;
            --header-from: #1B3068;
            --header-to:   #2D5BB5;
            --input-bg: #ffffff;
            --border: #E3E8F7;
            --text-main: #1a1f36;
            --text-muted: #8892B0;
            --accent-green: #22C55E;
            --radius-bubble: 18px;
        }

        html, body {
            height: 100%;
            overflow: hidden;
        }

        body {
            background: var(--header-from);
            color: var(--text-main);
        }

        /* ===== 容器 ===== */
        /* JS 会通过 visualViewport 动态设置高度来处理 iOS 软键盘 */
        .chat-container {
            width: 100%;
            height: 100vh;
            height: 100dvh;
            background: var(--bg);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
        }
        @media (min-width: 900px){
            body{
                background: radial-gradient(1100px 520px at 15% -8%, #2D5BB5 0%, transparent 58%),
                            radial-gradient(900px 520px at 85% 0%, #7C5CFF 0%, transparent 55%),
                            linear-gradient(135deg, #0F1F4D 0%, #1B3068 42%, #2D5BB5 100%);
            }
            .chat-container{
                width: min(840px, calc(100vw - 28px));
                height: min(860px, calc(100dvh - 28px));
                max-height: calc(100dvh - 28px);
                left: 50%; right:auto; transform:translateX(-50%);
                border-radius: 22px;
                box-shadow: 0 28px 70px rgba(0,0,0,0.30), 0 10px 24px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.07);
                overflow:hidden;
            }
            .chat-header{ border-radius:22px 22px 0 0; }
            .chat-input-area{ border-radius:0 0 22px 22px; }
        }


        /* ===== 头部 ===== */
        .chat-header {
            background: linear-gradient(135deg, #1B3068 0%, #2648A0 55%, #2D5BB5 100%);
            color: white;
            padding: 14px 16px;
            padding-top: calc(14px + env(safe-area-inset-top));
            display: flex;
            align-items: center;
            flex-shrink: 0;
            box-shadow: 0 4px 20px rgba(27, 48, 104, 0.38), inset 0 1px 0 rgba(255,255,255,0.12);
            position: relative;
            gap: 12px;
            overflow:hidden;
        }
        .chat-header::after{
            content:''; position:absolute; inset:0;
            background: radial-gradient(600px 120px at 20% -10%, rgba(255,255,255,0.12), transparent 60%),
                        radial-gradient(400px 140px at 90% 0%, rgba(124,92,255,0.18), transparent 60%);
            pointer-events:none;
        }

        /* 左侧 logo 圆圈 */
        .header-logo {
            width: 38px;
            height: 38px;
            min-width: 38px;
            border-radius: 12px;
            background: linear-gradient(135deg, rgba(255,255,255,0.20), rgba(255,255,255,0.08));
            border: 1px solid rgba(255,255,255,0.28);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.05rem;
            flex-shrink: 0;
            backdrop-filter: blur(6px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.18);
        }

        .chat-header-content {
            flex: 1;
            min-width: 0;
        }

        .chat-header-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 6px;
        }

        .chat-header h1 {
            font-size: 0.95rem;
            font-weight: 700;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex: 1;
            min-width: 0;
            letter-spacing: 0.01em;
        }

        .header-buttons {
            display: flex;
            gap: 6px;
            align-items: center;
            flex-shrink: 0;
        }

        .header-btn {
            padding: 4px 10px;
            border: 1px solid rgba(255,255,255,0.35);
            border-radius: 12px;
            cursor: pointer;
            font-weight: 600;
            font-size: 0.7rem;
            transition: all 0.15s;
            white-space: nowrap;
            min-height: 26px;
            background: rgba(255,255,255,0.12);
            color: white;
        }
        .header-btn:active { background: rgba(255,255,255,0.25); }

        .delete-btn {
            background: rgba(231, 76, 60, 0.75);
            border-color: rgba(231,76,60,0.5);
        }
        .delete-btn:active { background: rgba(192,57,43,0.9); }

        .creator-badge {
            background: rgba(255,255,255,0.15);
            border: 1px solid rgba(255,255,255,0.25);
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 0.65rem;
            font-weight: 600;
        }

        .chat-header-sub {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 2px;
        }

        .chat-id {
            font-size: 0.80rem;
            opacity: 0.90;
            white-space: nowrap;
            font-variant-numeric: tabular-nums;
            font-weight:700;
        }

        .expiry-info {
            font-size: 0.78rem;
            color: rgba(255,255,255,0.92);
            white-space: nowrap;
            font-weight:700;
        }

        /* ===== 消息列表 ===== */
        .chat-messages {
            flex: 1;
            padding: 16px 14px 10px;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            overscroll-behavior-y: contain;
            display: flex;
            flex-direction: column;
            gap: 12px;
            background: #EEF1FB;
            background-image: radial-gradient(circle at 1px 1px, rgba(79,110,247,0.05) 1px, transparent 0), linear-gradient(180deg, rgba(255,255,255,0.55) 0%, transparent 220px);
            background-size: 28px 28px, 100% 220px;
        }

        /* 滚动条：手机和电脑都加粗加深，方便拖动 */
        .chat-messages {
            scrollbar-width: auto;
            scrollbar-color: rgba(79,110,247,0.55) rgba(227,232,247,0.45);
        }
        .chat-messages::-webkit-scrollbar { width: 10px; }
        .chat-messages::-webkit-scrollbar-track {
            background: rgba(227,232,247,0.45);
            border-radius: 999px;
        }
        .chat-messages::-webkit-scrollbar-thumb {
            background: rgba(79,110,247,0.58);
            border: 2px solid rgba(227,232,247,0.45);
            border-radius: 999px;
        }
        .chat-messages::-webkit-scrollbar-thumb:hover,
        .chat-messages::-webkit-scrollbar-thumb:active {
            background: rgba(79,110,247,0.78);
        }

        @media (min-width: 769px) {
            .chat-messages {
                scrollbar-color: rgba(79,110,247,0.60) rgba(227,232,247,0.65);
            }
            .chat-messages::-webkit-scrollbar { width: 14px; }
            .chat-messages::-webkit-scrollbar-track {
                background: rgba(227,232,247,0.65);
                border-radius: 999px;
            }
            .chat-messages::-webkit-scrollbar-thumb {
                background: rgba(79,110,247,0.60);
                border: 3px solid rgba(227,232,247,0.65);
                border-radius: 999px;
            }
            .chat-messages::-webkit-scrollbar-thumb:hover,
            .chat-messages::-webkit-scrollbar-thumb:active {
                background: rgba(79,110,247,0.82);
            }
        }

        /* 消息气泡行（含头像）*/
        .message-row {
            display: flex;
            align-items: flex-end;
            gap: 8px;
        }
        .message-row.self-row { flex-direction: row-reverse; }

        /* 头像 */
        .msg-avatar {
            width: 30px;
            height: 30px;
            min-width: 30px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.7rem;
            font-weight: 700;
            color: white;
            flex-shrink: 0;
            margin-bottom: 2px;
        }
        .msg-avatar.self-av  { background: linear-gradient(135deg, #4f7cf7, #6b4fff); }
        .msg-avatar.other-av { background: linear-gradient(135deg, #36b7a0, #2d9cdb); }

        /* 气泡本体 */
        .message {
            max-width: 76%;
            padding: 10px 14px;
            border-radius: 18px;
            position: relative;
            animation: msgIn 0.24s cubic-bezier(.18,.89,.32,1.1);
            word-wrap: break-word;
            line-height:1.55;
        }
        @keyframes msgIn {
            from { opacity: 0; transform: scale(0.92) translateY(6px); }
            to   { opacity: 1; transform: scale(1)    translateY(0); }
        }

        .message.self {
            background: linear-gradient(135deg, #4F6EF7 0%, #6b5CFF 100%);
            color: white;
            border-bottom-right-radius: 6px;
            box-shadow: 0 4px 14px rgba(79,110,247,0.32), 0 1px 3px rgba(0,0,0,0.08);
        }
        .message.other {
            background: #ffffff;
            border: 1px solid #E6EBFF;
            border-bottom-left-radius: 6px;
            box-shadow: 0 3px 12px rgba(27,48,104,0.07), 0 1px 2px rgba(0,0,0,0.04);
        }

        .message-info {
            font-size: 0.62rem;
            opacity: 0.6;
            margin-bottom: 4px;
            font-weight: 500;
        }
        .message.self .message-info { opacity: 0.7; }

        .message-content { word-break: break-word; font-size: 0.92rem; line-height: 1.5; }

        .message-image {
            max-width: 100%;
            border-radius: 10px;
            margin-top: 4px;
            cursor: pointer;
            max-height: 240px;
            object-fit: cover;
            display: block;
            transition: transform 0.15s;
        }
        .message-image:active { transform: scale(0.97); }

        .message-video {
            width: 100%;
            max-width: 300px;
            border-radius: 12px;
            margin-top: 4px;
            background: #000;
            overflow: hidden;
        }
        .video-player {
            width: 100%;
            display: block;
            border-radius: 12px;
            outline: none;
            max-height: 260px;
            object-fit: contain;
        }

        .message-file {
            display: inline-flex;
            align-items: center;
            padding: 8px 12px;
            background: rgba(0,0,0,0.07);
            border-radius: 10px;
            text-decoration: none;
            color: inherit;
            margin-top: 4px;
            font-size: 0.82rem;
            gap: 7px;
            word-break: break-all;
            border: 1px solid rgba(0,0,0,0.06);
        }
        .self .message-file { background: rgba(255,255,255,0.18); color: white; border-color: rgba(255,255,255,0.2); }

        /* 语音消息 */
        .voice-message {
            display: flex;
            align-items: center;
            padding: 7px 10px;
            background: rgba(0,0,0,0.06);
            border-radius: 22px;
            margin-top: 4px;
            min-width: 140px;
            gap: 8px;
        }
        .self .voice-message { background: rgba(255,255,255,0.18); }

        .voice-play-btn {
            width: 32px;
            height: 32px;
            min-width: 32px;
            border-radius: 50%;
            background: white;
            border: none;
            color: var(--primary);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            font-size: 0.75rem;
            box-shadow: 0 2px 6px rgba(0,0,0,0.15);
            transition: transform 0.12s;
        }
        .voice-play-btn:active { transform: scale(0.9); }
        .self .voice-play-btn { background: rgba(255,255,255,0.92); color: var(--primary-dark); }

        .voice-waveform { flex: 1; height: 26px; position: relative; overflow: hidden; }
        .voice-wave {
            position: absolute; bottom: 0; width: 100%; height: 100%;
            display: flex; align-items: flex-end; gap: 2px;
        }
        .voice-bar {
            flex: 1; background: var(--primary); border-radius: 2px; min-height: 2px;
            transition: height 0.3s ease; opacity: 0.7;
        }
        .self .voice-bar { background: rgba(255,255,255,0.85); }

        .voice-duration { font-size: 0.72rem; color: var(--text-muted); min-width: 26px; font-variant-numeric: tabular-nums; }
        .self .voice-duration { color: rgba(255,255,255,0.7); }

        @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0.25; }
        }

        .chat-empty-hint {
            text-align: center;
            color: var(--text-muted);
            margin: 30px auto 0;
            font-size: 0.84rem;
            line-height: 1.75;
            padding: 24px 18px;
            background: linear-gradient(180deg, #ffffff 0%, #F8FAFF 100%);
            border: 1px solid #E6EBFF;
            border-radius: 18px;
            max-width: 360px;
            box-shadow: 0 10px 24px rgba(79,110,247,0.08), 0 2px 8px rgba(0,0,0,0.04);
        }
        .chat-empty-hint::before{ content:'🔗'; display:block; font-size:1.7rem; margin-bottom:8px; filter:drop-shadow(0 2px 6px rgba(79,110,247,0.15)); }
        .chat-empty-hint strong { color: var(--primary); font-weight:800; }

        /* ===== 底部整体 ===== */
        .chat-input-area {
            padding: 10px 12px;
            padding-bottom: calc(12px + env(safe-area-inset-bottom));
            border-top: 1px solid #E6EBFF;
            display: flex;
            flex-direction: column;
            gap: 8px;
            flex-shrink: 0;
            background: linear-gradient(180deg, #ffffff 0%, #FBFCFF 100%);
            box-shadow: 0 -4px 20px rgba(79,110,247,0.08), inset 0 1px 0 rgba(255,255,255,0.6);
        }

        /* 分享区 — 极简横条 */
        .share-area {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 10px;
            background: linear-gradient(135deg, #F4F7FF 0%, #EEF2FF 100%);
            border-radius: 12px;
            border: 1px solid #E0E7FF;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.7);
        }
        .share-icon { font-size: 0.9rem; flex-shrink: 0; opacity: 0.6; }

        .share-input {
            flex: 1;
            min-width: 0;
            border: none;
            background: transparent;
            font-size: 0.72rem;
            color: var(--text-muted);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            outline: none;
        }

        .share-btn {
            padding: 4px 11px;
            height: 26px;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 7px;
            cursor: pointer;
            font-size: 0.7rem;
            white-space: nowrap;
            flex-shrink: 0;
            font-weight: 700;
            letter-spacing: 0.02em;
            transition: background 0.15s;
        }
        .share-btn:active { background: var(--primary-dark); }
        .share-btn.copied { background: var(--accent-green); }

        /* 用户身份行 */
        .user-info {
            display: flex;
            gap: 6px;
            align-items: center;
            font-size: 0.75rem;
            color: var(--text-muted);
            padding: 0 2px;
        }
        .user-id { font-weight: 700; color: var(--primary); }
        .creator-tag {
            font-size: 0.65rem;
            background: linear-gradient(90deg,#f97316,#ef4444);
            color: white;
            padding: 1px 6px;
            border-radius: 6px;
            font-weight: 700;
        }

        /* 输入行 */
        .input-area { display: flex; flex-direction: column; gap: 6px; }

        .input-row {
            display: flex;
            gap: 7px;
            align-items: flex-end;
        }
        .input-left, .input-right { display: flex; align-items: center; flex-shrink: 0; }
        .input-center { flex: 1; display: flex; gap: 7px; min-width: 0; }

        /* 图标按钮 */
        .icon-btn {
            width: 40px;
            height: 40px;
            min-width: 40px;
            border: none;
            background: #F0F3FF;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            font-size: 1.15rem;
            transition: background 0.15s, transform 0.12s;
            color: var(--primary);
            flex-shrink: 0;
        }
        .icon-btn:active { background: #D9E0FF; transform: scale(0.92); }

        /* 兼容旧 class 名 */
        .mode-switch-btn, .plus-btn { 
            width: 40px; height: 40px; min-width: 40px; border: none;
            background: #F0F3FF; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; font-size: 1.15rem;
            transition: background 0.15s, transform 0.12s;
            position: relative; flex-shrink: 0;
        }
        .plus-btn { font-size: 1.45rem; }
        .mode-switch-btn:active, .plus-btn:active { background: #D9E0FF; transform: scale(0.92); }

        .message-input-container { flex: 1; min-width: 0; position: relative; }

        .message-input {
            display: block;
            width: 100%;
            padding: 10px 14px;
            border: 1.5px solid var(--border);
            border-radius: 22px;
            outline: none;
            resize: none;
            height: 42px;
            min-height: 42px;
            max-height: 120px;
            font-size: 0.93rem;
            background: #FAFBFF;
            line-height: 20px;
            overflow-y: hidden;
            transition: border-color 0.18s, box-shadow 0.18s;
            color: var(--text-main);
        }
        .message-input::placeholder { color: #B4BBCE; }
        .message-input:focus {
            border-color: var(--primary);
            background: white;
            box-shadow: 0 0 0 3px rgba(79,110,247,0.1);
        }

        .voice-input-btn {
            width: 100%;
            padding: 0 14px;
            border: 1.5px solid var(--border);
            border-radius: 22px;
            background: #FAFBFF;
            color: var(--text-muted);
            font-size: 0.88rem;
            cursor: pointer;
            display: none;
            align-items: center;
            justify-content: center;
            height: 42px;
            font-weight: 600;
            transition: all 0.15s;
        }
        .voice-input-btn.recording {
            background: #FFF0F0;
            color: #e74c3c;
            border-color: #e74c3c;
            animation: recordPulse 1.2s infinite;
        }
        @keyframes recordPulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(231,76,60,0.3); }
            50%       { box-shadow: 0 0 0 5px rgba(231,76,60,0); }
        }

        /* 发送按钮 */
        .send-btn {
            width: 42px;
            height: 42px;
            min-width: 42px;
            border: none;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--primary), #6b4fff);
            color: white;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.1rem;
            transition: all 0.15s;
            flex-shrink: 0;
            box-shadow: 0 3px 10px rgba(79,110,247,0.4);
        }
        .send-btn:active { transform: scale(0.9); box-shadow: 0 1px 4px rgba(79,110,247,0.3); }
        .send-btn:disabled {
            background: #D1D9F0;
            box-shadow: none;
            cursor: not-allowed;
        }

        /* ===== 菜单 ===== */
        .menu-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.3);
            backdrop-filter: blur(2px);
            z-index: 998;
            display: none;
        }

        .menu-container {
            position: fixed;
            bottom: calc(90px + env(safe-area-inset-bottom));
            right: 14px;
            background: white;
            border-radius: 16px;
            box-shadow: 0 8px 32px rgba(27,48,104,0.2), 0 2px 8px rgba(0,0,0,0.08);
            padding: 8px;
            z-index: 999;
            display: none;
            flex-direction: column;
            gap: 2px;
            min-width: 168px;
            border: 1px solid var(--border);
        }
        .menu-container.show {
            display: flex;
            animation: menuSlide 0.2s cubic-bezier(.18,.89,.32,1.1);
        }
        @keyframes menuSlide {
            from { opacity: 0; transform: translateY(12px) scale(0.95); }
            to   { opacity: 1; transform: translateY(0)   scale(1); }
        }

        .menu-item {
            display: flex;
            align-items: center;
            padding: 11px 14px;
            border: none;
            background: white;
            border-radius: 10px;
            cursor: pointer;
            font-size: 0.88rem;
            gap: 11px;
            min-height: 46px;
            color: var(--text-main);
            font-weight: 500;
            transition: background 0.12s;
        }
        .menu-item:active { background: #F0F3FF; }
        .menu-icon { font-size: 1.2rem; width: 28px; text-align: center; }

        /* 隐藏文件输入 */
        .file-input, .voice-input, .camera-input, .video-input { display: none; }

        /* 拖拽上传遮罩：覆盖整个聊天窗口，避免 Windows 浏览器在子元素间拖动时闪烁 */
        .drop-zone {
            position: fixed;
            inset: 0;
            z-index: 9998;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 24px;
            text-align: center;
            font-size: 1rem;
            font-weight: 800;
            color: white;
            background: rgba(27, 48, 104, 0.72);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            pointer-events: none;
        }
        .drop-zone.active { display: flex; }
        .drop-zone::before {
            content: '松开鼠标上传文件';
            width: min(86vw, 520px);
            min-height: 180px;
            border: 2px dashed rgba(255,255,255,0.86);
            border-radius: 22px;
            background: rgba(255,255,255,0.14);
            box-shadow: 0 20px 60px rgba(0,0,0,0.25);
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .drop-zone.active::after {
            content: '支持图片、视频和普通文件，上传时会显示进度条';
            position: absolute;
            margin-top: 250px;
            font-size: 0.82rem;
            font-weight: 600;
            color: rgba(255,255,255,0.82);
        }

        /* 上传进度提示 */
        .upload-progress-box {
            display: none;
            width: 100%;
            background: #F4F7FF;
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 8px 10px;
            box-shadow: 0 2px 10px rgba(79,110,247,0.08);
        }
        .upload-progress-box.show { display: block; }
        .upload-progress-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            font-size: 0.76rem;
            color: var(--text-main);
            margin-bottom: 6px;
        }
        .upload-progress-name {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-weight: 700;
        }
        .upload-progress-percent {
            flex-shrink: 0;
            color: var(--primary);
            font-weight: 800;
            font-variant-numeric: tabular-nums;
        }
        .upload-progress-track {
            width: 100%;
            height: 8px;
            overflow: hidden;
            border-radius: 999px;
            background: #DDE5FF;
        }
        .upload-progress-bar {
            width: 0%;
            height: 100%;
            border-radius: 999px;
            background: linear-gradient(90deg, var(--primary), #6b4fff);
            transition: width 0.15s ease;
        }
        .upload-progress-detail {
            margin-top: 5px;
            font-size: 0.68rem;
            color: var(--text-muted);
            font-variant-numeric: tabular-nums;
        }

        /* ===== 模态框 ===== */
        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            inset: 0;
            background: rgba(5,5,15,0.94);
            touch-action: manipulation;
            overflow: hidden;
            padding: calc(56px + env(safe-area-inset-top)) 12px calc(52px + env(safe-area-inset-bottom));
        }
        .modal.open {
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            animation: fadeIn 0.2s;
        }

        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        .modal-content {
            display: block;
            width: auto;
            height: auto;
            max-width: calc(100vw - 24px);
            max-height: calc(100dvh - 130px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
            object-fit: contain;
            border-radius: 8px;
            margin: 0 auto;
        }
        .video-modal-content {
            display: block;
            width: auto;
            height: auto;
            max-width: calc(100vw - 24px);
            max-height: calc(100dvh - 130px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
            object-fit: contain;
            border-radius: 8px;
            margin: 0 auto;
        }
        .close {
            position: fixed;
            top: calc(14px + env(safe-area-inset-top));
            right: 14px;
            color: white;
            font-size: 20px;
            cursor: pointer;
            z-index: 1001;
            width: 40px;
            height: 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(255,255,255,0.15);
            border-radius: 50%;
            backdrop-filter: blur(4px);
            border: 1px solid rgba(255,255,255,0.2);
        }
        .close:active { background: rgba(255,255,255,0.25); }
        .modal-caption {
            margin-top: 12px;
            text-align: center;
            color: rgba(255,255,255,0.5);
            font-size: 0.8rem;
            padding: 0 20px;
            padding-bottom: env(safe-area-inset-bottom);
        }

        /* ===== 通知 ===== */
        /* 消息操作区 */
        .message-actions {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            flex-wrap: wrap;
            margin-top: 8px;
            gap: 6px;
        }
        .message.other .message-actions { justify-content: flex-start; }
        .msg-copy-btn,
        .msg-delete-btn {
            border: none;
            color: #fff;
            cursor: pointer;
            font-size: 0.76rem;
            line-height: 1;
            font-weight: 700;
            padding: 6px 10px;
            border-radius: 999px;
            min-height: 28px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: background 0.15s, transform 0.1s;
            white-space: nowrap;
            letter-spacing: 0;
        }
        .msg-copy-btn {
            background: var(--primary);
            box-shadow: 0 2px 6px rgba(79,110,247,0.22);
        }
        .msg-copy-btn:hover { background: var(--primary-dark); }
        .msg-copy-btn:active { background: var(--primary-dark); transform: scale(0.96); }
        .msg-copy-btn.copied { background: var(--accent-green); }
        .msg-delete-btn {
            background: #e74c3c;
            box-shadow: 0 2px 6px rgba(231,76,60,0.22);
        }
        .msg-delete-btn:hover { background: #c0392b; }
        .msg-delete-btn:active { background: #a93226; transform: scale(0.96); }
        /* 消息过期倒计时 */
        .msg-expire-countdown {
            display: inline-flex;
            align-items: center;
            min-height: 28px;
            padding: 6px 10px;
            border-radius: 999px;
            font-size: 0.76rem;
            line-height: 1;
            font-weight: 700;
            color: #465064;
            background: rgba(255,255,255,0.86);
            border: 1px solid rgba(70,80,100,0.10);
            white-space: nowrap;
            font-variant-numeric: tabular-nums;
        }
        .message.self .msg-expire-countdown {
            color: rgba(255,255,255,0.96);
            background: rgba(255,255,255,0.18);
            border-color: rgba(255,255,255,0.28);
        }
        .msg-expire-countdown.urgent {
            color: #e74c3c;
            background: #fff5f5;
            border-color: #ffd6d6;
            font-weight: 800;
        }
        .message.self .msg-expire-countdown.urgent {
            color: #fff;
            background: rgba(231,76,60,0.55);
            border-color: rgba(255,255,255,0.34);
        }
        .deleted-notice {
            background: #FFF0F0;
            color: #C62828;
            padding: 12px 15px;
            text-align: center;
            border-radius: 12px;
            margin: 6px;
            font-weight: 600;
            font-size: 0.85rem;
            border: 1px solid #FCCACA;
        }
        .loading { text-align: center; padding: 10px; color: var(--text-muted); font-size: 0.82rem; }
        .file-icon { flex-shrink: 0; }
        /* ===== 实时语音 - 专业重设计 v2 ===== */
        .voice-join-btn{
            height:32px; padding:0 14px; border-radius:999px;
            background:#fff; color:#1B3068; border:1px solid rgba(255,255,255,0.95);
            font-weight:800; font-size:0.75rem; letter-spacing:.01em;
            display:inline-flex; align-items:center; gap:7px;
            box-shadow:0 2px 10px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.6); transition:all .18s;
        }
        .voice-join-btn:hover{ transform:translateY(-1px); box-shadow:0 6px 16px rgba(0,0,0,0.18); }
        .voice-join-btn:active{ transform:translateY(0); }
        .voice-join-btn.joined{ background:linear-gradient(135deg,#EF4444,#DC2626); color:#fff; border-color:rgba(239,68,68,0.9); box-shadow:0 4px 14px rgba(239,68,68,0.32); }
        .voice-join-btn .vj-icon{ width:16px; height:16px; display:inline-flex; align-items:center; justify-content:center; font-size:0.82rem; }
        .voice-header-pill{
            display:inline-flex; align-items:center; gap:7px;
            padding:6px 12px; border-radius:999px;
            background:rgba(255,255,255,0.16); border:1px solid rgba(255,255,255,0.22);
            font-size:0.68rem; font-weight:800; color:#fff; backdrop-filter:blur(10px);
            cursor:pointer; transition:all .18s; user-select:none;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.15);
        }
        .voice-header-pill.hidden{ display:none; }
        .voice-header-pill:hover{ background:rgba(255,255,255,0.22); transform:translateY(-1px); }
        .pill-dot{ width:8px; height:8px; border-radius:50%; background:#94a3b8; flex-shrink:0; box-shadow:0 0 0 2px rgba(255,255,255,0.15); }
        .pill-dot.live{ background:#22C55E; box-shadow:0 0 0 7px rgba(34,197,94,0.18); animation:pulseDot 1.6s infinite; }
        .pill-dot.connecting{ background:#F59E0B; animation:blink 1s infinite; }
        @keyframes pulseDot{ 0%{ box-shadow:0 0 0 0 rgba(34,197,94,0.35);} 70%{ box-shadow:0 0 0 8px rgba(34,197,94,0);} 100%{ box-shadow:0 0 0 0 rgba(34,197,94,0);} }
        .voice-bar{
            margin:12px 12px 0; background:linear-gradient(180deg,#ffffff 0%,#FCFDFF 100%); border:1px solid #E6EBFF; border-radius:18px;
            box-shadow:0 12px 32px rgba(27,48,104,0.13), 0 4px 12px rgba(79,110,247,0.07), inset 0 1px 0 rgba(255,255,255,0.9);
            padding:14px; display:flex; flex-direction:column; gap:12px;
            animation:voiceSlideIn .25s cubic-bezier(.18,.89,.32,1.15);
            position:relative; overflow:hidden;
        }
        .voice-bar::before{
            content:''; position:absolute; top:0; left:0; right:0; height:1px;
            background:linear-gradient(90deg, transparent, rgba(79,110,247,0.18), transparent);
        }
        .voice-bar.hidden{ display:none; }
        @keyframes voiceSlideIn{ from{ opacity:0; transform:translateY(-8px) scale(.98);} to{ opacity:1; transform:translateY(0) scale(1);} }
        .voice-bar-top{ display:flex; align-items:center; gap:12px; }
        .voice-status{ display:flex; align-items:center; gap:9px; font-weight:800; font-size:0.88rem; color:#1B3068; min-width:0; letter-spacing:.01em; }
        .voice-dot{ width:10px; height:10px; border-radius:50%; background:#CBD5E1; position:relative; flex-shrink:0; transition:background .2s; }
        .voice-dot.live{ background:#22C55E; box-shadow:0 0 0 7px rgba(34,197,94,0.15); animation:pulseDot 1.6s infinite; }
        .voice-dot.connecting{ background:#F59E0B; animation:blink 1s infinite; }
        .voice-status-text{ letter-spacing:.01em; white-space:nowrap; }
        .voice-timer{ font-variant-numeric:tabular-nums; font-size:0.74rem; color:#7B88A8; font-weight:700; margin-left:2px; white-space:nowrap; background:#F1F5FF; padding:2px 7px; border-radius:999px; border:1px solid #E6EBFF; }
        .voice-peers{ flex:1; display:flex; gap:10px; overflow-x:auto; scrollbar-width:thin; scrollbar-color:#D9E0FF transparent; padding:3px 2px 6px; min-width:0; scroll-behavior:smooth; mask-image:linear-gradient(to right, transparent, black 10px, black calc(100% - 10px), transparent); -webkit-mask-image:linear-gradient(to right, transparent, black 10px, black calc(100% - 10px), transparent); }
        .voice-peers::-webkit-scrollbar{ height:5px; } .voice-peers::-webkit-scrollbar-thumb{ background:#D9E0FF; border-radius:999px; } .voice-peers::-webkit-scrollbar-thumb:hover{ background:#BFCBFF; }
        .voice-peer{
            flex:0 0 auto; display:flex; flex-direction:column; align-items:center; gap:6px;
            min-width:76px; max-width:84px; padding:10px 8px 14px; border-radius:14px; background:#F8FAFF; border:1px solid #EEF2FF;
            position:relative; transition:all .2s cubic-bezier(.18,.89,.32,1.1);
        }
        .voice-peer:hover{ transform:translateY(-2px); box-shadow:0 6px 16px rgba(79,110,247,0.10); border-color:#DDE5FF; }
        .voice-peer.me{ background:linear-gradient(180deg,#F0FFF4 0%,#ECFDF5 100%); border-color:#C6F6D5; }
        .voice-peer.speaking{ border-color:#86EFAC; background:linear-gradient(180deg,#ECFDF5 0%,#D1FAE5 100%); box-shadow:0 6px 18px rgba(34,197,94,0.18); transform:translateY(-2px) scale(1.02); }
        .voice-peer-avatar{
            width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center;
            font-weight:800; font-size:0.96rem; color:#fff; position:relative;
            background:linear-gradient(135deg,#4F6EF7,#7C5CFF); box-shadow:0 4px 12px rgba(79,110,247,0.30), inset 0 1px 0 rgba(255,255,255,0.25);
            transition:all .2s;
        }
        .voice-peer.me .voice-peer-avatar{ background:linear-gradient(135deg,#22C55E,#16a34a); box-shadow:0 4px 12px rgba(34,197,94,0.30); }
        .voice-peer-avatar.speaking{ box-shadow:0 0 0 3px rgba(34,197,94,0.32), 0 6px 16px rgba(34,197,94,0.22); animation:speakingPulse 1.6s infinite; }
        @keyframes speakingPulse{ 0%{ box-shadow:0 0 0 0 rgba(34,197,94,0.45), 0 4px 12px rgba(0,0,0,0.08);} 70%{ box-shadow:0 0 0 8px rgba(34,197,94,0), 0 6px 16px rgba(34,197,94,0.12);} 100%{ box-shadow:0 0 0 0 rgba(34,197,94,0), 0 4px 12px rgba(0,0,0,0.08);} }
        .voice-peer-mic{ position:absolute; right:-3px; bottom:-3px; width:18px; height:18px; border-radius:50%; background:#fff; border:1.5px solid #E6EBFF; display:flex; align-items:center; justify-content:center; font-size:0.66rem; box-shadow:0 2px 6px rgba(0,0,0,0.10); transition:all .15s; }
        .voice-peer-mic.muted{ background:#FFF1F1; border-color:#FECACA; color:#EF4444; }
        .voice-peer-name{ font-size:0.70rem; font-weight:800; color:#1e293b; max-width:76px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1; letter-spacing:.01em; }
        .voice-peer-sub{ font-size:0.60rem; color:#7B88A8; font-weight:700; line-height:1; background:#fff; padding:2px 6px; border-radius:999px; border:1px solid #EEF2FF; }
        .voice-peer.me .voice-peer-sub{ color:#16a34a; background:#F0FFF4; border-color:#C6F6D5; }
        .voice-peer-level{ position:absolute; left:10px; right:10px; bottom:5px; height:3px; background:#E6EBFF; border-radius:999px; overflow:hidden; opacity:0; transition:opacity .2s; }
        .voice-peer.speaking .voice-peer-level{ opacity:1; }
        .voice-peer-level-fill{ height:100%; width:0%; background:linear-gradient(90deg,#22C55E,#06B6D4 50%, #4F6EF7); transition:width .08s linear; border-radius:999px; }
        .voice-controls{ display:flex; gap:8px; margin-left:auto; flex-shrink:0; }
        .voice-ctrl-btn{
            height:36px; padding:0 16px; border-radius:999px; border:1px solid #E6EBFF; background:#fff; color:#1e293b;
            font-size:0.78rem; font-weight:800; cursor:pointer; display:inline-flex; align-items:center; gap:6px;
            box-shadow:0 2px 8px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.6); transition:all .18s; white-space:nowrap;
        }
        .voice-ctrl-btn:hover{ background:#F8FAFF; border-color:#CBD5E1; transform:translateY(-1px); box-shadow:0 6px 14px rgba(0,0,0,0.08); }
        .voice-ctrl-btn:active{ transform:translateY(0); box-shadow:0 1px 4px rgba(0,0,0,0.04); }
        .voice-ctrl-btn.muted{ background:linear-gradient(135deg,#FFF7ED,#FFF1F1); border-color:#FECACA; color:#DC2626; box-shadow:0 2px 8px rgba(239,68,68,0.12); }
        .voice-ctrl-btn.leave{ background:#fff; color:#DC2626; border-color:#FEE2E2; }
        .voice-ctrl-btn.leave:hover{ background:linear-gradient(135deg,#DC2626,#B91C1C); color:#fff; border-color:#DC2626; box-shadow:0 6px 16px rgba(220,38,38,0.24); }
        .voice-ctrl-btn.primary{ background:linear-gradient(135deg,#22C55E,#16a34a); color:#fff; border-color:#16a34a; box-shadow:0 4px 12px rgba(34,197,94,0.28); }
        .voice-audios{ position:fixed; left:0; top:0; width:1px; height:1px; overflow:hidden; opacity:0.01; pointer-events:none; display:block; z-index:-1; }
        .voice-debug{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:0.80rem; line-height:1.55; letter-spacing:.01em; color:#1e293b; background:linear-gradient(180deg,#F8FAFF 0%,#F1F5FF 100%); border:1px solid #CBD5E1; padding:9px 12px; display:none; max-height:88px; overflow:auto; border-radius:10px; margin:8px 12px 0; position:relative; z-index:2; box-shadow:0 2px 10px rgba(79,110,247,0.08); font-weight:600; }
        .voice-debug.show{ display:block; }
        @media (max-width:560px){
            .chat-header{ padding:10px 12px; padding-top:calc(10px + env(safe-area-inset-top)); }
            .header-buttons{ gap:6px; }
            .voice-join-btn{ height:28px; padding:0 11px; font-size:0.70rem; }
            .voice-join-btn .vj-text{ display:inline; } /* 手机也显示文字，确保右上角为文字按钮 */
            .creator-badge{ display:none; }
            .chat-header-sub{ gap:6px; }
            .chat-header-sub .expiry-info:last-child{ display:none; }
            .voice-bar{ margin:8px 8px 0; padding:10px; border-radius:14px; }
            .voice-bar-top{ flex-wrap:wrap; gap:10px; }
            .voice-peers{ order:3; width:100%; flex-basis:100%; }
            .voice-controls{ width:100%; }
            .voice-ctrl-btn{ flex:1; justify-content:center; height:36px; }
        }
    </style>
</head>
<body>
    <div class="chat-container">
        <div class="chat-header">
            <div class="header-logo">🔐</div>
            <div class="chat-header-content">
                <div class="chat-header-top">
                    <h1>公司内部文件安全传输</h1>
                    <div class="header-buttons">
                        <?php if ($is_creator): ?>
                            <span class="creator-badge">创建者</span>
                        <?php endif; ?>
                        <div class="voice-header-pill hidden" id="voice-header-pill" onclick="document.getElementById('voice-bar').classList.toggle('hidden')" title="点击展开/收起语音面板">
                            <span class="pill-dot idle" id="pill-dot"></span>
                            <span id="voice-header-status">未加入</span>
                            <span id="voice-header-count" style="opacity:.82">· 0人</span>
                        </div>
                        <button class="header-btn voice-join-btn" id="voice-join-btn" title="加入/挂断实时语音"><span class="vj-icon">🎙️</span><span class="vj-text">加入语音</span></button>
                        <button class="header-btn delete-btn" id="delete-btn" title="清空聊天记录">清空</button>
                    </div>
                </div>
                <div class="chat-header-sub">
                    <div class="chat-id">ID: <?php echo $share_id; ?></div>
                    <div class="expiry-info" id="expiry-info">消息保留7天</div>
                    <div class="expiry-info" style="margin-left:auto; opacity:.94; font-size:.80rem; font-weight:800; letter-spacing:.02em;">🔒 端到端 · 点击 🎙️ 即时语音</div>
                </div>
            </div>
        </div>
        <div class="voice-bar hidden" id="voice-bar">
            <div class="voice-bar-top">
                <div class="voice-status"><span class="voice-dot idle" id="voice-dot"></span><span class="voice-status-text" id="voice-status-text">通话中</span><span class="voice-timer" id="voice-timer"></span></div>
                <div class="voice-peers" id="voice-peers"></div>
                <div class="voice-controls">
                    <button class="voice-ctrl-btn" id="voice-mute-btn" title="静音/取消静音"><span>🎤</span><span class="vc-text">麦克风开</span></button>
                    <button class="voice-ctrl-btn leave" id="voice-leave-btn" title="挂断语音"><span>✕</span>挂断</button>
                </div>
            </div>
        </div>
        <div class="voice-audios" id="voice-audios" aria-hidden="true"></div>
        
        <div class="chat-messages" id="messages-container">
            <?php if (empty($messages)): ?>
                <div class="chat-empty-hint">
                    🔗 将下方链接发给对方<br>
                    <strong>通过同一链接进入</strong>才能一起聊天
                </div>
            <?php else: ?>
                <?php foreach ($messages as $message): ?>
                    <?php
                        $msgTime = date('H:i', $message['timestamp']); // 北京时间
                        $expireTs = $message['timestamp'] + 7 * 24 * 3600; // 7天后时间戳
                    ?>
                    <div class="message <?php echo ($message['sender_id'] === $user_id) ? 'self' : 'other'; ?>" data-id="<?php echo $message['id']; ?>" data-expire="<?php echo $expireTs; ?>">
                        <div class="message-info">
                            <?php echo htmlspecialchars($message['sender_name']); ?> • 
                            <?php echo $msgTime; ?>
                        </div>
                        <div class="message-content">
                            <?php if ($message['type'] === 'text'): ?>
                                <?php echo $message['content']; ?>
                            <?php elseif ($message['type'] === 'image' || strpos($message['type'], 'image/') === 0): ?>
                                <img src="uploads/<?php echo $message['content']; ?>" 
                                     class="message-image" 
                                     alt="图片"
                                     onclick="openImageModal(this.src, '<?php echo htmlspecialchars($message['sender_name']); ?>')">
                            <?php elseif ($message['type'] === 'video' || strpos($message['type'], 'video/') === 0): ?>
                                <div class="message-video">
                                    <video class="video-player" controls onclick="openVideoModal(this)">
                                        <source src="uploads/<?php echo $message['content']; ?>" type="video/mp4">
                                        您的浏览器不支持视频播放
                                    </video>
                                </div>
                            <?php elseif ($message['type'] === 'voice'): ?>
                                <div class="voice-message">
                                    <button class="voice-play-btn" onclick="playVoiceMessage(this, 'uploads/<?php echo $message['content']; ?>')">
                                        ▶
                                    </button>
                                    <div class="voice-waveform">
                                        <div class="voice-wave" id="wave-<?php echo $message['id']; ?>">
                                            <!-- 波形条将通过JavaScript动态生成 -->
                                        </div>
                                    </div>
                                    <div class="voice-duration">
                                        <?php echo isset($message['duration']) ? $message['duration'] . 's' : '0s'; ?>
                                    </div>
                                </div>
                            <?php else: ?>
                                <a href="uploads/<?php echo $message['content']; ?>" download="<?php echo $message['original_name']; ?>" class="message-file">
                                    <span class="file-icon">📎</span> <?php echo $message['original_name']; ?>
                                </a>
                            <?php endif; ?>
                        </div>
                        <div class="message-actions">
                            <button class="msg-copy-btn" onclick="copyThisMessage(this)">复制此条消息</button>
                            <span class="msg-expire-countdown" data-expire="<?php echo $expireTs; ?>"></span>
                            <button class="msg-delete-btn" onclick="deleteSingleMessage('<?php echo $message['id']; ?>', this)">删除此条消息</button>
                        </div>
                    </div>
                <?php endforeach; ?>
            <?php endif; ?>
        </div>
        
        <!-- 图片模态框 -->
        <div id="imageModal" class="modal">
            <span class="close" onclick="closeImageModal()">&times;</span>
            <img class="modal-content" id="modalImage">
            <div id="modalCaption" class="modal-caption"></div>
        </div>
        
        <!-- 视频模态框 -->
        <div id="videoModal" class="modal">
            <span class="close" onclick="closeVideoModal()">&times;</span>
            <video class="video-modal-content" id="modalVideo" controls>
                您的浏览器不支持视频播放
            </video>
            <div id="videoCaption" class="modal-caption"></div>
        </div>
        
        <div class="drop-zone" id="drop-zone" aria-hidden="true">
            松开鼠标上传文件
        </div>
        
        <div class="chat-input-area">
            <div class="share-area">
                <input type="text" class="share-input" id="share-link" value="<?php echo htmlspecialchars($share_url); ?>" readonly>
                <button class="share-btn" id="copy-link-btn">复制加入链接</button>
            </div>
            
            <div class="user-info">
                <span>您的身份:</span>
                <span class="user-id"><?php echo '用户' . substr($user_id, -6); ?></span>
                <?php if ($is_creator): ?>
                    <span style="color: #e74c3c; font-weight: bold;">(创建者)</span>
                <?php endif; ?>
            </div>
            
            <div class="input-area">
                <div class="upload-progress-box" id="upload-progress-box">
                    <div class="upload-progress-info">
                        <span class="upload-progress-name" id="upload-progress-name">准备上传...</span>
                        <span class="upload-progress-percent" id="upload-progress-percent">0%</span>
                    </div>
                    <div class="upload-progress-track">
                        <div class="upload-progress-bar" id="upload-progress-bar"></div>
                    </div>
                    <div class="upload-progress-detail" id="upload-progress-detail">0 / 0</div>
                </div>
                <div class="input-row">
                    <div class="input-left">
                        <button class="mode-switch-btn" id="mode-switch-btn">🎤</button>
                    </div>
                    <div class="input-center">
                        <div class="message-input-container">
                            <textarea class="message-input" id="message-input" placeholder="输入消息..."></textarea>
                            <button class="voice-input-btn" id="voice-input-btn">按住 说话</button>
                        </div>
                        <button class="send-btn" id="send-btn">发送</button>
                    </div>
                    <div class="input-right">
                        <button class="plus-btn" id="plus-btn">+</button>
                    </div>
                </div>
                
                <!-- 菜单 -->
                <div class="menu-overlay" id="menu-overlay"></div>
                <div class="menu-container" id="menu-container">
                    <button class="menu-item" id="photo-menu-item">
                        <span class="menu-icon">🖼️</span>
                        <span>照片</span>
                    </button>
                    <button class="menu-item" id="camera-menu-item">
                        <span class="menu-icon">📷</span>
                        <span>拍摄照片</span>
                    </button>
                    <button class="menu-item" id="video-menu-item">
                        <span class="menu-icon">🎥</span>
                        <span>拍摄视频</span>
                    </button>
                    <button class="menu-item" id="file-menu-item">
                        <span class="menu-icon">📎</span>
                        <span>上传文件</span>
                    </button>
                </div>
                
                <input type="file" id="file-input" class="file-input" accept="*/*">
                <input type="file" id="photo-input" class="file-input" accept="image/*">
                <input type="file" id="camera-input" class="camera-input" accept="image/*" capture="camera">
                <input type="file" id="video-input" class="video-input" accept="video/*" capture="camcorder">
                <input type="file" id="voice-input" class="voice-input" accept="audio/*" capture="microphone">
            </div>
        </div>
    </div>

    <script>
        document.addEventListener('DOMContentLoaded', function() {
            const messagesContainer = document.getElementById('messages-container');
            
            // ===== 北京时间格式化 =====
            function formatBeijingTime(unixTs) {
                return new Date(unixTs * 1000).toLocaleTimeString('zh-CN', {
                    hour: '2-digit', minute: '2-digit', hour12: false,
                    timeZone: 'Asia/Shanghai'
                });
            }
            
            // ===== 每条消息的7天倒计时 =====
            function formatExpireCountdown(expireTs) {
                const now = Math.floor(Date.now() / 1000);
                const left = expireTs - now;
                if (left <= 0) return '已过期';
                const d = Math.floor(left / 86400);
                const h = Math.floor((left % 86400) / 3600);
                const m = Math.floor((left % 3600) / 60);
                return `${d}天${h}时${m}分钟后自动删除`;
            }
            
            function updateAllExpireCountdowns() {
                document.querySelectorAll('.msg-expire-countdown[data-expire]').forEach(el => {
                    const expireTs = parseInt(el.getAttribute('data-expire'), 10);
                    const now = Math.floor(Date.now() / 1000);
                    const left = expireTs - now;
                    el.textContent = formatExpireCountdown(expireTs);
                    el.classList.toggle('urgent', left < 3600);
                });
            }
            
            // 初始刷新，之后每分钟更新一次
            updateAllExpireCountdowns();
            setInterval(updateAllExpireCountdowns, 60000);
            const messageInput = document.getElementById('message-input');
            const voiceInputBtn = document.getElementById('voice-input-btn');
            const modeSwitchBtn = document.getElementById('mode-switch-btn');
            const sendBtn = document.getElementById('send-btn');
            const plusBtn = document.getElementById('plus-btn');
            const menuOverlay = document.getElementById('menu-overlay');
            const menuContainer = document.getElementById('menu-container');
            const photoMenuItem = document.getElementById('photo-menu-item');
            const cameraMenuItem = document.getElementById('camera-menu-item');
            const videoMenuItem = document.getElementById('video-menu-item');
            const fileMenuItem = document.getElementById('file-menu-item');
            const fileInput = document.getElementById('file-input');
            const photoInput = document.getElementById('photo-input');
            const cameraInput = document.getElementById('camera-input');
            const videoInput = document.getElementById('video-input');
            const voiceInput = document.getElementById('voice-input');
            const deleteBtn = document.getElementById('delete-btn');
            const dropZone = document.getElementById('drop-zone');
            const shareLink = document.getElementById('share-link');
            const copyLinkBtn = document.getElementById('copy-link-btn');
            const uploadProgressBox = document.getElementById('upload-progress-box');
            const uploadProgressName = document.getElementById('upload-progress-name');
            const uploadProgressPercent = document.getElementById('upload-progress-percent');
            const uploadProgressBar = document.getElementById('upload-progress-bar');
            const uploadProgressDetail = document.getElementById('upload-progress-detail');
            
            // 语音录制相关变量
            let mediaRecorder = null;
            let audioChunks = [];
            let isRecording = false;
            let recordingStartTime = 0;
            let recordingTimer = null;
            let recordingMime = '';
            let currentAudio = null;
            let voiceButtonPressed = false;
            let isVoiceMode = false;
            
            // 存储已显示消息的ID，避免重复显示
            let displayedMessageIds = new Set();
            
            // 初始化：收集已显示消息的ID
            document.querySelectorAll('.message[data-id]').forEach(message => {
                const messageId = message.getAttribute('data-id');
                if (messageId) {
                    displayedMessageIds.add(messageId);
                }
            });
            
            // 初始化语音消息波形
            initializeVoiceWaveforms();
            
            // 自动滚动到底部
            function scrollToBottom() {
                setTimeout(() => {
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                }, 100);
            }
            
            scrollToBottom();

            function formatUploadSize(bytes) {
                bytes = Number(bytes) || 0;
                if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
                if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
                if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
                return bytes + ' B';
            }

            function showUploadProgress(fileName, fileSize) {
                if (!uploadProgressBox) return;
                uploadProgressName.textContent = fileName || '正在上传...';
                uploadProgressPercent.textContent = '0%';
                uploadProgressBar.style.width = '0%';
                uploadProgressDetail.textContent = '0 / ' + formatUploadSize(fileSize || 0);
                uploadProgressBox.classList.add('show');
            }

            function updateUploadProgress(loaded, total) {
                if (!uploadProgressBox) return;
                total = Number(total) || 0;
                loaded = Number(loaded) || 0;
                const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
                uploadProgressPercent.textContent = percent + '%';
                uploadProgressBar.style.width = percent + '%';
                uploadProgressDetail.textContent = formatUploadSize(loaded) + ' / ' + (total > 0 ? formatUploadSize(total) : '未知大小');
            }

            function hideUploadProgress(delay = 700) {
                if (!uploadProgressBox) return;
                setTimeout(() => {
                    uploadProgressBox.classList.remove('show');
                    uploadProgressBar.style.width = '0%';
                }, delay);
            }

            // 统一控制文字输入框高度：发送/清空后恢复 42px，输入多行时最高 120px。
            function resizeMessageInput() {
                const minHeight = 42;
                const maxHeight = 120;

                messageInput.style.height = minHeight + 'px';

                if (messageInput.value.trim() === '') {
                    messageInput.style.overflowY = 'hidden';
                    return;
                }

                const nextHeight = Math.min(messageInput.scrollHeight, maxHeight);
                messageInput.style.height = Math.max(nextHeight, minHeight) + 'px';
                messageInput.style.overflowY = messageInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
            }
            
            // 切换输入模式
            function toggleInputMode() {
                isVoiceMode = !isVoiceMode;
                
                if (isVoiceMode) {
                    // 切换到语音模式
                    messageInput.style.display = 'none';
                    voiceInputBtn.style.display = 'flex';
                    modeSwitchBtn.textContent = '⌨️';
                    sendBtn.disabled = true;
                } else {
                    // 切换到键盘模式
                    messageInput.style.display = 'block';
                    voiceInputBtn.style.display = 'none';
                    modeSwitchBtn.textContent = '🎤';
                    sendBtn.disabled = messageInput.value.trim() === '';
                }
            }
            
            // 发送消息
            function sendMessage() {
                const message = messageInput.value.trim();
                if (message === '') return;
                
                const formData = new FormData();
                formData.append('action', 'send_message');
                formData.append('message', message);
                
                fetch('', {
                    method: 'POST',
                    body: formData
                })
                .then(response => response.json())
                .then(data => {
                    if (data.status === 'success') {
                        messageInput.value = '';
                        addMessageToChat(data.message, true);
                        // 重置输入框高度，避免每次发送后越来越高
                        resizeMessageInput();
                        sendBtn.disabled = true;
                    }
                })
                .catch(error => console.error('发送消息错误:', error));
            }
            
            // 添加消息到聊天界面
            function addMessageToChat(message, isSelf = false) {
                // 如果消息已经显示过，跳过
                if (displayedMessageIds.has(message.id)) {
                    return;
                }
                
                const messageEl = document.createElement('div');
                messageEl.className = `message ${isSelf ? 'self' : 'other'}`;
                messageEl.setAttribute('data-id', message.id);
                
                let contentHtml = '';
                if (message.type === 'text') {
                    contentHtml = message.content;
                } else if (message.type === 'image' || message.type.startsWith('image/')) {
                    contentHtml = `<img src="uploads/${message.content}" class="message-image" alt="图片" onclick="openImageModal(this.src, '${message.sender_name}')">`;
                } else if (message.type === 'video' || message.type.startsWith('video/')) {
                    contentHtml = `
                        <div class="message-video">
                            <video class="video-player" controls onclick="openVideoModal(this)">
                                <source src="uploads/${message.content}" type="video/mp4">
                                您的浏览器不支持视频播放
                            </video>
                        </div>
                    `;
                } else if (message.type === 'voice') {
                    contentHtml = `
                        <div class="voice-message">
                            <button class="voice-play-btn" onclick="playVoiceMessage(this, 'uploads/${message.content}')">
                                ▶
                            </button>
                            <div class="voice-waveform">
                                <div class="voice-wave" id="wave-${message.id}">
                                    <!-- 波形条将通过JavaScript动态生成 -->
                                </div>
                            </div>
                            <div class="voice-duration">
                                ${message.duration || 0}s
                            </div>
                        </div>
                    `;
                } else {
                    contentHtml = `<a href="uploads/${message.content}" download="${message.original_name}" class="message-file"><span class="file-icon">📎</span> ${message.original_name}</a>`;
                }
                
                messageEl.setAttribute('data-expire', String(message.timestamp + 7 * 24 * 3600));
                
                messageEl.innerHTML = `
                    <div class="message-info">
                        ${message.sender_name} • ${formatBeijingTime(message.timestamp)}
                    </div>
                    <div class="message-content">
                        ${contentHtml}
                    </div>
                    <div class="message-actions">
                        <button class="msg-copy-btn" onclick="copyThisMessage(this)">复制此条消息</button>
                        <span class="msg-expire-countdown" data-expire="${message.timestamp + 7 * 24 * 3600}"></span>
                        <button class="msg-delete-btn" onclick="deleteSingleMessage('${message.id}', this)">删除此条消息</button>
                    </div>
                `;
                
                const emptyHint = messagesContainer.querySelector('.chat-empty-hint');
                if (emptyHint) emptyHint.remove();

                messagesContainer.appendChild(messageEl);
                displayedMessageIds.add(message.id);
                
                // 刷新倒计时显示
                updateAllExpireCountdowns();
                
                // 如果是语音消息，初始化波形
                if (message.type === 'voice') {
                    initializeVoiceWaveform(message.id);
                }
                
                scrollToBottom();
            }
            
            // 初始化所有语音消息的波形
            function initializeVoiceWaveforms() {
                document.querySelectorAll('.voice-wave').forEach(wave => {
                    const messageId = wave.id.replace('wave-', '');
                    initializeVoiceWaveform(messageId);
                });
            }
            
            // 初始化单个语音消息的波形
            function initializeVoiceWaveform(messageId) {
                const wave = document.getElementById(`wave-${messageId}`);
                if (!wave) return;
                
                wave.innerHTML = '';
                const barCount = 20;
                
                for (let i = 0; i < barCount; i++) {
                    const bar = document.createElement('div');
                    bar.className = 'voice-bar';
                    // 随机高度，模拟语音波形
                    const height = Math.random() * 20 + 5;
                    bar.style.height = `${height}px`;
                    wave.appendChild(bar);
                }
            }
            
            // 播放语音消息（兼容手机/电脑，避免上一段音频状态影响下一段）
            window.playVoiceMessage = function(button, audioUrl) {
                function isSelfButton(btn) {
                    const msg = btn && btn.closest ? btn.closest('.message') : null;
                    return !!(msg && msg.classList.contains('self'));
                }

                function resetPlayButton(btn) {
                    if (!btn) return;
                    btn.innerHTML = '▶';
                    btn.style.background = isSelfButton(btn) ? 'rgba(255, 255, 255, 0.9)' : '#4a6ee0';
                }

                // 停止当前播放的音频
                if (currentAudio) {
                    currentAudio.pause();
                    currentAudio.src = '';
                    currentAudio = null;
                }

                document.querySelectorAll('.voice-play-btn').forEach(resetPlayButton);

                button.innerHTML = '❚❚';
                button.style.background = '#e74c3c';

                const audio = new Audio();
                currentAudio = audio;
                audio.preload = 'auto';
                audio.src = audioUrl;

                audio.addEventListener('ended', function() {
                    resetPlayButton(button);
                    if (currentAudio === audio) currentAudio = null;
                });

                audio.addEventListener('error', function(e) {
                    console.error('语音播放失败:', e, audio.error, audioUrl);
                    resetPlayButton(button);
                    if (currentAudio === audio) currentAudio = null;
                    alert('语音播放失败，请确认服务器 uploads 目录可访问，并且没有把 webm/ogg/m4a 禁止访问。');
                });

                const playPromise = audio.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(function(error) {
                        console.error('语音播放被浏览器拦截或格式不支持:', error, audioUrl);
                        resetPlayButton(button);
                        if (currentAudio === audio) currentAudio = null;
                        alert('语音播放失败：当前浏览器可能不支持此音频格式，或播放被系统拦截。');
                    });
                }
            };

            // 打开视频模态框
            window.openVideoModal = function(videoElement) {
                const modal = document.getElementById('videoModal');
                const modalVideo = document.getElementById('modalVideo');
                const captionText = document.getElementById('videoCaption');
                
                modal.style.display = 'block';
                modalVideo.src = videoElement.src;
                modalVideo.load();
                captionText.innerHTML = `由 ${videoElement.closest('.message').querySelector('.message-info').textContent.split('•')[0].trim()} 发送`;
                
                // 点击模态框背景关闭
                modal.addEventListener('click', function(e) {
                    if (e.target === modal) {
                        closeVideoModal();
                    }
                });
                
                // ESC键关闭
                document.addEventListener('keydown', function(e) {
                    if (e.key === 'Escape') {
                        closeVideoModal();
                    }
                });
            };
            
            // 关闭视频模态框
            window.closeVideoModal = function() {
                const modal = document.getElementById('videoModal');
                const modalVideo = document.getElementById('modalVideo');
                
                modal.style.display = 'none';
                modalVideo.pause();
                modalVideo.src = '';
            };
            
            // 获取所有消息（用于同步）- 添加新消息、移除已删除消息
            function fetchMessages() {
                const formData = new FormData();
                formData.append('action', 'get_messages');
                
                fetch('', {
                    method: 'POST',
                    body: formData,
                    cache: 'no-store'
                })
                .then(response => response.json())
                .then(data => {
                    if (data.status === 'success') {
                        const serverIds = new Set(data.messages.map(m => m.id));
                        
                        // 移除本地已显示但服务器已删除的消息
                        displayedMessageIds.forEach(id => {
                            if (!serverIds.has(id)) {
                                const el = document.querySelector(`.message[data-id="${id}"]`);
                                if (el) el.remove();
                                displayedMessageIds.delete(id);
                            }
                        });
                        
                        if (serverIds.size === 0 && displayedMessageIds.size === 0 && !messagesContainer.querySelector('.chat-empty-hint')) {
                            messagesContainer.innerHTML = '<div class="chat-empty-hint">🔗 将下方链接发给对方<br><strong>通过同一链接进入</strong>才能一起聊天</div>';
                        } else if (serverIds.size > 0) {
                            const hint = messagesContainer.querySelector('.chat-empty-hint');
                            if (hint) hint.remove();
                        }

                        // 添加新消息
                        data.messages.forEach(message => {
                            if (!displayedMessageIds.has(message.id)) {
                                addMessageToChat(message, message.is_self);
                            }
                        });
                    }
                })
                .catch(error => console.error('获取消息错误:', error));
            }
            
            // 后台检查创建者状态：只更新页面局部元素，不整页刷新
            function checkCreatorStatus() {
                const formData = new FormData();
                formData.append('action', 'check_creator_status');

                fetch('', {
                    method: 'POST',
                    body: formData,
                    cache: 'no-store'
                })
                .then(response => response.json())
                .then(data => {
                    const headerButtons = document.querySelector('.header-buttons');
                    if (!headerButtons) return;

                    let badge = headerButtons.querySelector('.creator-badge');
                    if (data.is_creator) {
                        if (!badge) {
                            badge = document.createElement('span');
                            badge.className = 'creator-badge';
                            badge.textContent = '创建者';
                            headerButtons.insertBefore(badge, headerButtons.firstChild);
                        }
                    } else if (badge) {
                        badge.remove();
                    }
                })
                .catch(error => console.error('后台检查创建者状态错误:', error));
            }

            // 上传文件 / 图片 / 视频：使用 XMLHttpRequest 才能显示真实上传进度
            function uploadFile(file) {
                if (!file) return;

                const formData = new FormData();
                formData.append('action', 'upload_file');
                formData.append('file', file);

                showUploadProgress(file.name || '正在上传文件', file.size || 0);

                const xhr = new XMLHttpRequest();
                xhr.open('POST', '', true);
                xhr.responseType = 'json';

                xhr.upload.onprogress = function(e) {
                    if (e.lengthComputable) {
                        updateUploadProgress(e.loaded, e.total);
                    } else {
                        uploadProgressPercent.textContent = '上传中';
                        uploadProgressDetail.textContent = formatUploadSize(e.loaded) + ' / 未知大小';
                    }
                };

                xhr.onload = function() {
                    let data = xhr.response;
                    if (!data && xhr.responseText) {
                        try { data = JSON.parse(xhr.responseText); } catch (e) {}
                    }

                    if (xhr.status >= 200 && xhr.status < 300 && data && data.status === 'success') {
                        updateUploadProgress(file.size || 1, file.size || 1);
                        addMessageToChat(data.message, true);
                        hideUploadProgress(600);
                    } else {
                        hideUploadProgress(1200);
                        alert('上传失败: ' + ((data && data.message) ? data.message : '服务器返回异常'));
                    }
                };

                xhr.onerror = function() {
                    hideUploadProgress(1200);
                    alert('上传失败：网络异常或连接中断');
                };

                xhr.onabort = function() {
                    hideUploadProgress(1200);
                    alert('上传已取消');
                };

                xhr.send(formData);
            }
            
            // 选择当前浏览器支持的录音格式
            function getSupportedRecordingMime() {
                if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
                const candidates = [
                    'audio/webm;codecs=opus',
                    'audio/webm',
                    'audio/mp4;codecs=mp4a.40.2',
                    'audio/mp4',
                    'audio/ogg;codecs=opus',
                    'audio/ogg'
                ];
                return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
            }

            // 开始录音：电脑 Chrome/Edge 优先 webm，iPhone/Safari 自动选择 mp4/m4a
            async function startRecording() {
                if (isRecording) return;

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
                    alert('当前浏览器不支持直接录音，请改用文件方式上传语音。');
                    voiceInput.click();
                    return;
                }

                let stream = null;
                try {
                    stream = await navigator.mediaDevices.getUserMedia({ audio: true });

                    recordingMime = getSupportedRecordingMime();
                    const recorderOptions = recordingMime ? { mimeType: recordingMime } : undefined;
                    mediaRecorder = new MediaRecorder(stream, recorderOptions);
                    recordingMime = mediaRecorder.mimeType || recordingMime || 'audio/webm';

                    audioChunks = [];

                    mediaRecorder.ondataavailable = (event) => {
                        if (event.data && event.data.size > 0) {
                            audioChunks.push(event.data);
                        }
                    };

                    mediaRecorder.onerror = (event) => {
                        console.error('录音过程错误:', event.error || event);
                        alert('录音失败，请检查浏览器麦克风权限。');
                    };

                    mediaRecorder.onstop = () => {
                        const recordingDuration = Math.max(1, Math.floor((Date.now() - recordingStartTime) / 1000));
                        const finalMime = mediaRecorder.mimeType || recordingMime || (audioChunks[0] && audioChunks[0].type) || 'audio/webm';

                        if (audioChunks.length > 0) {
                            const audioBlob = new Blob(audioChunks, { type: finalMime });
                            uploadVoiceMessage(audioBlob, recordingDuration, finalMime);
                        } else {
                            alert('没有录到声音，请重新按住录音。');
                        }

                        stream.getTracks().forEach(track => track.stop());
                        hideRecordingUI();
                    };

                    mediaRecorder.start(250);
                    isRecording = true;
                    recordingStartTime = Date.now();
                    showRecordingUI();
                    recordingTimer = setInterval(updateRecordingTime, 1000);

                } catch (error) {
                    console.error('录音失败:', error);
                    if (stream) stream.getTracks().forEach(track => track.stop());
                    hideRecordingUI();
                    alert('无法访问麦克风，请检查手机/电脑浏览器的麦克风权限。');
                    voiceInput.click();
                }
            }

            // 停止录音
            function stopRecording() {
                if (mediaRecorder && isRecording) {
                    try {
                        if (mediaRecorder.state === 'recording' && typeof mediaRecorder.requestData === 'function') {
                            mediaRecorder.requestData();
                        }
                        if (mediaRecorder.state !== 'inactive') {
                            mediaRecorder.stop();
                        }
                    } catch (error) {
                        console.error('停止录音失败:', error);
                        hideRecordingUI();
                    }
                    isRecording = false;

                    if (recordingTimer) {
                        clearInterval(recordingTimer);
                        recordingTimer = null;
                    }
                }
            }

            // 显示录音界面
            function showRecordingUI() {
                voiceInputBtn.classList.add('recording');
                voiceInputBtn.textContent = '松开 结束';
            }
            
            // 隐藏录音界面
            function hideRecordingUI() {
                voiceInputBtn.classList.remove('recording');
                voiceInputBtn.textContent = '按住 说话';
            }
            
            // 更新录音时间
            function updateRecordingTime() {
                // 可以在录音按钮上显示时间，但为了简洁，这里不显示
            }
            
            // 上传语音消息
            function getAudioExtFromMime(mime) {
                mime = (mime || '').toLowerCase();
                if (mime.includes('webm')) return 'webm';
                if (mime.includes('ogg') || mime === 'audio/opus') return 'ogg';
                if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
                if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
                if (mime.includes('wav')) return 'wav';
                return 'webm';
            }

            function uploadVoiceMessage(audioBlob, duration, mimeType) {
                const formData = new FormData();
                const realMime = mimeType || audioBlob.type || 'audio/webm';
                const ext = getAudioExtFromMime(realMime);
                formData.append('action', 'upload_voice');
                formData.append('voice', audioBlob, `voice_message.${ext}`);
                formData.append('duration', duration);

                showUploadProgress(`语音消息.${ext}`, audioBlob.size || 0);

                const xhr = new XMLHttpRequest();
                xhr.open('POST', '', true);
                xhr.responseType = 'json';

                xhr.upload.onprogress = function(e) {
                    if (e.lengthComputable) {
                        updateUploadProgress(e.loaded, e.total);
                    }
                };

                xhr.onload = function() {
                    let data = xhr.response;
                    if (!data && xhr.responseText) {
                        try { data = JSON.parse(xhr.responseText); } catch (e) {}
                    }

                    if (xhr.status >= 200 && xhr.status < 300 && data && data.status === 'success') {
                        updateUploadProgress(audioBlob.size || 1, audioBlob.size || 1);
                        addMessageToChat(data.message, true);
                        hideUploadProgress(600);
                    } else {
                        hideUploadProgress(1200);
                        alert('语音上传失败: ' + ((data && data.message) ? data.message : '服务器返回异常'));
                    }
                };

                xhr.onerror = function() {
                    hideUploadProgress(1200);
                    alert('语音上传失败：网络异常或连接中断');
                };

                xhr.send(formData);
            }
            
            // 显示菜单
            function showMenu() {
                menuOverlay.style.display = 'block';
                menuContainer.classList.add('show');
            }
            
            // 隐藏菜单
            function hideMenu() {
                menuOverlay.style.display = 'none';
                menuContainer.classList.remove('show');
            }
            
            // 复制分享链接
            copyLinkBtn.addEventListener('click', function() {
                shareLink.select();
                shareLink.setSelectionRange(0, 99999); // 移动设备支持
                
                try {
                    const successful = document.execCommand('copy');
                    if (successful) {
                        const originalText = copyLinkBtn.textContent;
                        copyLinkBtn.textContent = '已复制!';
                        setTimeout(() => {
                            copyLinkBtn.textContent = originalText;
                        }, 2000);
                    } else {
                        alert('复制失败，请手动复制链接');
                        shareLink.focus();
                        shareLink.select();
                        // 尝试使用现代API
                        if (navigator.clipboard) {
                            navigator.clipboard.writeText(shareLink.value);
                        }
                    }
                } catch (err) {
                    // 使用现代API
                    if (navigator.clipboard) {
                        navigator.clipboard.writeText(shareLink.value).then(function() {
                            const originalText = copyLinkBtn.textContent;
                            copyLinkBtn.textContent = '已复制!';
                            setTimeout(() => {
                                copyLinkBtn.textContent = originalText;
                            }, 2000);
                        }, function() {
                            alert('复制失败，请手动复制链接');
                            shareLink.focus();
                            shareLink.select();
                        });
                    } else {
                        alert('复制失败，请手动复制链接');
                        shareLink.focus();
                        shareLink.select();
                    }
                }
            });
            
            // 事件监听
            modeSwitchBtn.addEventListener('click', toggleInputMode);
            
            sendBtn.addEventListener('click', sendMessage);
            
            messageInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            });
            
            messageInput.addEventListener('input', function() {
                // 自动调整输入框高度
                resizeMessageInput();
                
                // 启用/禁用发送按钮
                sendBtn.disabled = this.value.trim() === '';
            });
            
            // 语音按钮事件
            voiceInputBtn.addEventListener('mousedown', function(e) {
                if (e.button === 0) { // 左键
                    voiceButtonPressed = true;
                    startRecording();
                }
            });
            
            voiceInputBtn.addEventListener('touchstart', function(e) {
                e.preventDefault();
                voiceButtonPressed = true;
                startRecording();
            });
            
            voiceInputBtn.addEventListener('mouseup', function() {
                if (voiceButtonPressed) {
                    voiceButtonPressed = false;
                    stopRecording();
                }
            });
            
            voiceInputBtn.addEventListener('touchend', function(e) {
                e.preventDefault();
                if (voiceButtonPressed) {
                    voiceButtonPressed = false;
                    stopRecording();
                }
            });
            
            voiceInputBtn.addEventListener('mouseleave', function() {
                if (voiceButtonPressed && isRecording) {
                    voiceButtonPressed = false;
                    stopRecording();
                }
            });
            
            // 菜单按钮事件
            plusBtn.addEventListener('click', showMenu);
            
            menuOverlay.addEventListener('click', hideMenu);
            
            // 菜单项事件
            photoMenuItem.addEventListener('click', function() {
                hideMenu();
                photoInput.click();
            });
            
            cameraMenuItem.addEventListener('click', function() {
                hideMenu();
                cameraInput.click();
            });
            
            videoMenuItem.addEventListener('click', function() {
                hideMenu();
                videoInput.click();
            });
            
            fileMenuItem.addEventListener('click', function() {
                hideMenu();
                fileInput.click();
            });
            
            // 文件输入事件
            photoInput.addEventListener('change', function() {
                if (photoInput.files.length > 0) {
                    uploadFile(photoInput.files[0]);
                }
            });
            
            cameraInput.addEventListener('change', function() {
                if (cameraInput.files.length > 0) {
                    uploadFile(cameraInput.files[0]);
                }
            });
            
            videoInput.addEventListener('change', function() {
                if (videoInput.files.length > 0) {
                    uploadFile(videoInput.files[0]);
                }
            });
            
            fileInput.addEventListener('change', function() {
                if (fileInput.files.length > 0) {
                    uploadFile(fileInput.files[0]);
                }
            });
            
            // 文件选择方式上传语音（备用方案）
            voiceInput.addEventListener('change', function() {
                if (voiceInput.files.length > 0) {
                    const file = voiceInput.files[0];
                    // 创建临时音频元素获取时长
                    const audio = new Audio();
                    audio.src = URL.createObjectURL(file);
                    audio.addEventListener('loadedmetadata', function() {
                        const duration = Math.floor(audio.duration);
                        uploadVoiceMessage(file, duration, file.type);
                    });
                    audio.addEventListener('error', function() {
                        // 如果无法获取时长，默认设为0
                        uploadVoiceMessage(file, 0, file.type);
                    });
                }
            });
            
            // 删除聊天
            if (deleteBtn) {
                deleteBtn.addEventListener('click', function() {
                    if (confirm('确定要清空全部聊天记录吗？此操作不可撤销！')) {
                        const formData = new FormData();
                        formData.append('action', 'delete_chat');
                        
                        fetch('', {
                            method: 'POST',
                            body: formData
                        })
                        .then(response => response.json())
                        .then(data => {
                            if (data.status === 'success') {
                                // 清空消息显示，ID 保持可用
                                messagesContainer.innerHTML = '<div class="chat-empty-hint">🔗 将下方链接发给对方<br><strong>通过同一链接进入</strong>才能一起聊天</div>';
                                displayedMessageIds.clear();
                            } else {
                                alert('清空失败: ' + data.message);
                            }
                        })
                        .catch(error => console.error('清空聊天错误:', error));
                    }
                });
            }
            
            // 禁用聊天功能（保留用于兼容）
            function disableChat() {
                messageInput.disabled = true;
                voiceInputBtn.disabled = true;
                modeSwitchBtn.disabled = true;
                sendBtn.disabled = true;
                plusBtn.disabled = true;
                if (deleteBtn) deleteBtn.disabled = true;
                messageInput.placeholder = '聊天已被删除';
                clearInterval(messagePolling);
                clearInterval(creatorPolling);
            }
            
            // 粘贴图片
            messageInput.addEventListener('paste', function(e) {
                const items = e.clipboardData.items;
                for (let i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('image') !== -1) {
                        const file = items[i].getAsFile();
                        if (file) {
                            uploadFile(file);
                            e.preventDefault();
                            break;
                        }
                    }
                }
            });
            
            // 拖放上传：整个聊天窗口都可以拖拽上传。
            // 使用 dragDepth 计数，避免 Windows/Chrome 在经过子元素时反复 dragleave/dragenter 导致遮罩闪烁。
            let dragDepth = 0;

            function isFileDrag(e) {
                const types = e.dataTransfer && e.dataTransfer.types;
                if (!types) return false;
                return Array.prototype.indexOf.call(types, 'Files') !== -1;
            }

            function showDropZone() {
                if (dropZone) dropZone.classList.add('active');
            }

            function hideDropZone() {
                dragDepth = 0;
                if (dropZone) dropZone.classList.remove('active');
            }

            document.addEventListener('dragenter', function(e) {
                if (!isFileDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                dragDepth++;
                showDropZone();
            }, false);

            document.addEventListener('dragover', function(e) {
                if (!isFileDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                showDropZone();
            }, false);

            document.addEventListener('dragleave', function(e) {
                if (!isFileDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                dragDepth = Math.max(0, dragDepth - 1);
                if (dragDepth === 0) hideDropZone();
            }, false);

            document.addEventListener('drop', function(e) {
                if (!isFileDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                hideDropZone();

                const files = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : [];
                if (files.length > 0) {
                    uploadFile(files[0]);
                }
            }, false);

            window.addEventListener('blur', hideDropZone, false);
            document.addEventListener('visibilitychange', function() {
                if (document.hidden) hideDropZone();
            }, false);
            
            // 复制单条消息：文字复制内容，图片/视频/语音/文件复制文件链接
            window.copyThisMessage = function(btn) {
                const msgEl = btn && btn.closest ? btn.closest('.message') : null;
                const contentEl = msgEl ? msgEl.querySelector('.message-content') : null;
                if (!contentEl) return;

                let copyText = '';
                const fileLink = contentEl.querySelector('a.message-file');
                const img = contentEl.querySelector('img.message-image');
                const videoSource = contentEl.querySelector('video source');
                const voiceBtn = contentEl.querySelector('.voice-play-btn');

                if (fileLink && fileLink.href) {
                    copyText = fileLink.href;
                } else if (img && img.src) {
                    copyText = img.src;
                } else if (videoSource && videoSource.getAttribute('src')) {
                    copyText = new URL(videoSource.getAttribute('src'), window.location.href).href;
                } else if (voiceBtn) {
                    const onclickText = voiceBtn.getAttribute('onclick') || '';
                    const match = onclickText.match(/playVoiceMessage\(this,\s*['"]([^'"]+)['"]\)/);
                    if (match && match[1]) {
                        copyText = new URL(match[1], window.location.href).href;
                    }
                }

                if (!copyText) {
                    copyText = contentEl.innerText.trim();
                }
                if (!copyText) return;

                function showCopied() {
                    const oldText = btn.textContent;
                    btn.textContent = '已复制';
                    btn.classList.add('copied');
                    setTimeout(function() {
                        btn.textContent = oldText || '复制此条消息';
                        btn.classList.remove('copied');
                    }, 1200);
                }

                if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(copyText).then(showCopied).catch(function() {
                        fallbackCopy(copyText, showCopied);
                    });
                } else {
                    fallbackCopy(copyText, showCopied);
                }
            };

            function fallbackCopy(text, callback) {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.setAttribute('readonly', 'readonly');
                textarea.style.position = 'fixed';
                textarea.style.left = '-9999px';
                textarea.style.top = '0';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                try {
                    document.execCommand('copy');
                    if (callback) callback();
                } catch (e) {
                    alert('复制失败，请手动长按/选择内容复制');
                }
                document.body.removeChild(textarea);
            }
            
            // 单条消息删除（任何访客均可操作）
            window.deleteSingleMessage = function(messageId, btn) {
                if (!confirm('确定删除这条消息吗？')) return;
                
                const formData = new FormData();
                formData.append('action', 'delete_message');
                formData.append('message_id', messageId);
                
                fetch('', {
                    method: 'POST',
                    body: formData
                })
                .then(response => response.json())
                .then(data => {
                    if (data.status === 'success') {
                        const msgEl = btn.closest('.message');
                        if (msgEl) {
                            displayedMessageIds.delete(messageId);
                            msgEl.remove();
                        }
                    } else {
                        alert('删除失败: ' + (data.message || '未知错误'));
                    }
                })
                .catch(error => console.error('删除消息错误:', error));
            };
            
// ===== 实时语音聊天（WebRTC + JS后端，手机端强化版） =====
            const voiceJoinBtn = document.getElementById('voice-join-btn');
            const voiceBar = document.getElementById('voice-bar');
            const voiceDot = document.getElementById('voice-dot');
            const voiceStatusText = document.getElementById('voice-status-text');
            const voiceHeaderStatus = document.getElementById('voice-header-status');
            const voiceHeaderCount = document.getElementById('voice-header-count');
            const voicePeersEl = document.getElementById('voice-peers');
            const voiceMuteBtn = document.getElementById('voice-mute-btn');
            const voiceLeaveBtn = document.getElementById('voice-leave-btn');
            const voiceAudios = document.getElementById('voice-audios');
            const voiceHeaderPill = document.getElementById('voice-header-pill');
            const pillDot = document.getElementById('pill-dot');
            const voiceTimerEl = document.getElementById('voice-timer');
            let voiceTimerInt = null, voiceTimerSec = 0;
            let localAnalyser = null, localAnalyserData = null, levelRaf = null;
            let voiceDebugEl = document.getElementById('voice-debug');
            if(!voiceDebugEl){
                voiceDebugEl = document.createElement('div');
                voiceDebugEl.id='voice-debug';
                voiceDebugEl.className='voice-debug';
                voiceDebugEl.textContent='语音调试: 未加入';
                if(voiceBar && voiceBar.parentNode) voiceBar.parentNode.insertBefore(voiceDebugEl, voiceAudios ? voiceAudios.nextSibling : voiceBar.nextSibling);
            }
            function voiceLog(msg){
                console.log('[voice] '+msg);
                if(voiceDebugEl){
                    voiceDebugEl.classList.add('show');
                    const t=new Date().toLocaleTimeString();
                    voiceDebugEl.textContent='['+t+'] '+msg;
                }
            }
            let localStream = null;
            let pcs = {};
            let pendingIce = {};
            let isInVoice = false;
            let isMuted = false;
            let rtcPollTimer = null;
            let rtcHeartbeatTimer = null;
            const myUserId = '<?php echo addslashes($user_id); ?>';
            const rtcRoomId = '<?php echo addslashes($share_id); ?>';
            const rtcUserName = '用户' + myUserId.slice(-6);
            const rtcIceServers = [
                {urls:'stun:stun.l.google.com:19302'},
                {urls:'stun:stun1.l.google.com:19302'},
                {urls:'stun:stun2.l.google.com:19302'},
                // 自建 TURN（coturn@chat.lkz.pub → 47.102.196.219）— 跨网（5G/WiFi）中继
                // 域名形式用于 TLS 证书校验（turns），IP 形式兜底
                {urls:'turn:chat.lkz.pub:3478', username:'webrtc', credential:'H7TkZlhosqX5Yuhefk'},
                {urls:'turn:chat.lkz.pub:3478?transport=tcp', username:'webrtc', credential:'H7TkZlhosqX5Yuhefk'},
                {urls:'turns:chat.lkz.pub:5349', username:'webrtc', credential:'H7TkZlhosqX5Yuhefk'},
                {urls:'turns:chat.lkz.pub:5349?transport=tcp', username:'webrtc', credential:'H7TkZlhosqX5Yuhefk'},
                {urls:'turn:47.102.196.219:3478', username:'webrtc', credential:'H7TkZlhosqX5Yuhefk'},
                {urls:'turn:47.102.196.219:3478?transport=tcp', username:'webrtc', credential:'H7TkZlhosqX5Yuhefk'},
                {urls:'turns:47.102.196.219:5349', username:'webrtc', credential:'H7TkZlhosqX5Yuhefk'},
                {urls:'turns:47.102.196.219:5349?transport=tcp', username:'webrtc', credential:'H7TkZlhosqX5Yuhefk'}
            ];
            let ws = null, wsReady = false, useWS = false;
            function wsUrl(){ const proto = location.protocol==='https:'?'wss:':'ws:'; return proto+'//'+location.host+'/voice-ws'; }
            function connectWS(){
                if(ws && (ws.readyState===0||ws.readyState===1)) return;
                try{
                    ws = new WebSocket(wsUrl());
                    ws.onopen = ()=>{ wsReady=true; useWS=true; voiceLog('WS 已连接 '+wsUrl()); if(isInVoice){ try{ ws.send(JSON.stringify({type:'join', room: rtcRoomId, userId: myUserId, name: rtcUserName})); }catch(e){} } };
                    ws.onmessage = async (ev)=>{
                        let d; try{ d=JSON.parse(ev.data);}catch(e){return;}
                        if(d.type==='joined' || d.type==='peers'){ if(d.peers){ renderVoicePeers(d.peers); await pollRtcOnceAndOffer(d.peers); voiceLog('peers 更新: '+Object.keys(d.peers).length+'人'); } }
                        if(d.type==='signal'){
                            const sig = {from: d.from, type: d.kind || d.type, payload: d.payload};
                            voiceLog('收到信令 '+sig.type+' 来自 '+(sig.from||'unknown').slice(-6));
                            await handleRtcSignals([sig]);
                        }
                        if(d.type==='pong'){ }
                    };
                    ws.onclose = ()=>{ const wasInVoice = isInVoice && wsReady; wsReady=false; voiceLog('WS 断开'); if(wasInVoice){ try{ playDisconnectSound(); }catch(e){} } if(isInVoice && useWS){ useWS=false; if(!rtcPollTimer) rtcPollTimer=setInterval(pollRtc, 1200); } };
                    ws.onerror = (e)=>{ const wasInVoice = isInVoice; voiceLog('WS 错误'); wsReady=false; if(wasInVoice){ try{ playDisconnectSound(); }catch(e){} } };
                }catch(e){ voiceLog('WS 连接失败 '+e.message); }
            }
            try{ connectWS(); }catch(e){}
            setInterval(()=>{ if(!wsReady) connectWS(); }, 5000);

            function setVoiceStatus(text, state){
                if(voiceStatusText) voiceStatusText.textContent = text;
                if(voiceHeaderStatus) voiceHeaderStatus.textContent = text;
                if(voiceDot){
                    voiceDot.className = 'voice-dot' + (state==='connected'?' live':state==='connecting'?' connecting':' idle');
                }
                if(pillDot){
                    pillDot.className = 'pill-dot' + (state==='connected'?' live':state==='connecting'?' connecting':' idle');
                }
                if(voiceHeaderPill){
                    if(state==='idle') voiceHeaderPill.classList.add('hidden');
                    else voiceHeaderPill.classList.remove('hidden');
                }
                // timer
                if(state==='connected'){
                    voiceTimerSec=0;
                    if(voiceTimerEl) voiceTimerEl.textContent='00:00';
                    if(voiceTimerInt) clearInterval(voiceTimerInt);
                    voiceTimerInt=setInterval(()=>{
                        voiceTimerSec++;
                        const m=String(Math.floor(voiceTimerSec/60)).padStart(2,'0');
                        const s=String(voiceTimerSec%60).padStart(2,'0');
                        if(voiceTimerEl) voiceTimerEl.textContent=m+':'+s;
                    },1000);
                } else if(state==='idle'){
                    if(voiceTimerInt){ clearInterval(voiceTimerInt); voiceTimerInt=null; }
                    if(voiceTimerEl) voiceTimerEl.textContent='';
                    if(levelRaf){ cancelAnimationFrame(levelRaf); levelRaf=null; }
                    if(localAnalyser){ try{ localAnalyser.disconnect(); }catch(e){} localAnalyser=null; }
                }
                voiceLog('状态 '+text);
            }
            const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent);
            let remoteAnalysers = {}; // peerId -> {analyser, data, raf, src}
            let remoteWebAudio = {}; // peerId -> {src, gain} WebAudio 通用扬声器兜底
            let prevVoicePeerIds = new Set();
            let lastVoiceToneAt = 0;
            function enableWebAudioOutput(peerId, stream){
                if(!globalAudioContext || remoteWebAudio[peerId]) return false;
                try{
                    if(globalAudioContext.state==='suspended') globalAudioContext.resume().catch(()=>{});
                    const src = globalAudioContext.createMediaStreamSource(stream);
                    const gain = globalAudioContext.createGain();
                    gain.gain.value=1;
                    src.connect(gain);
                    gain.connect(globalAudioContext.destination);
                    remoteWebAudio[peerId]={src,gain};
                    voiceLog('WebAudio 扬声器兜底已启用 '+peerId.slice(-6));
                    return true;
                }catch(e){ voiceLog('WebAudio 兜底失败 '+e.message); return false; }
            }
            function disableWebAudioOutput(peerId){
                const n=remoteWebAudio[peerId];
                if(!n) return;
                try{ n.src.disconnect(); }catch(e){}
                try{ n.gain.disconnect(); }catch(e){}
                delete remoteWebAudio[peerId];
            }
            // ===== 语音提示音（加入 / 离开 / 与服务器断连）通用 WebAudio，无需外链 =====
            function ensureToneContext(){
                try{
                    const AC = window.AudioContext || window.webkitAudioContext;
                    if(!globalAudioContext && AC) globalAudioContext = new AC();
                    if(globalAudioContext && globalAudioContext.state === 'suspended') globalAudioContext.resume().catch(()=>{});
                    return globalAudioContext;
                }catch(e){ return null; }
            }
            function tone(freq, dur, type, vol, delay){
                const ctx = ensureToneContext();
                if(!ctx) return;
                try{
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = type || 'sine';
                    osc.frequency.value = freq;
                    gain.gain.value = vol != null ? vol : 0.18;
                    osc.connect(gain); gain.connect(ctx.destination);
                    const t = ctx.currentTime + (delay||0);
                    gain.gain.setValueAtTime(gain.gain.value, t);
                    gain.gain.exponentialRampToValueAtTime(0.0008, t + dur);
                    osc.start(t); osc.stop(t + dur + 0.02);
                }catch(e){}
            }
            function playJoinSound(){
                // 清亮上行：有人加入
                tone(880, 0.12, 'sine', 0.16, 0);
                tone(1108.73, 0.18, 'sine', 0.16, 0.13);
            }
            function playLeaveSound(){
                // 柔和下行：有人离开
                tone(659.25, 0.11, 'sine', 0.14, 0);
                tone(493.88, 0.18, 'sine', 0.14, 0.12);
            }
            let lastDisconnectToneAt = 0;
            function playDisconnectSound(){
                const now = Date.now();
                if(now - lastDisconnectToneAt < 2000) return;
                lastDisconnectToneAt = now;
                // 低沉双响：自己与服务器断连
                tone(220, 0.16, 'triangle', 0.22, 0);
                tone(174.61, 0.28, 'triangle', 0.22, 0.20);
                try{ if(navigator.vibrate) navigator.vibrate([120,80,120]); }catch(e){}
            }
            function renderVoicePeers(peers){
                const ids = peers ? Object.keys(peers) : [];
                const countText = ids.length + '人';
                if(voiceHeaderCount) voiceHeaderCount.textContent = '· ' + countText;
                if(voiceHeaderPill && ids.length>0) voiceHeaderPill.classList.remove('hidden');
                // 人员加入/离开 提示音：仅在已处于语音中且非首帧时触发，避免自己加入时误响
                try{
                    if(isInVoice && prevVoicePeerIds.size > 0){
                        const now = Date.now();
                        if(now - lastVoiceToneAt > 750){
                            const added = ids.filter(id => !prevVoicePeerIds.has(id) && id !== myUserId);
                            const removed = [...prevVoicePeerIds].filter(id => !ids.includes(id) && id !== myUserId);
                            if(added.length > 0){
                                playJoinSound();
                                lastVoiceToneAt = now;
                                voiceLog('🔔 有人加入语音');
                            } else if(removed.length > 0){
                                playLeaveSound();
                                lastVoiceToneAt = now;
                                voiceLog('🔕 有人离开语音');
                            }
                        }
                    }
                }catch(e){}
                if(!voicePeersEl) return;
                voicePeersEl.innerHTML = '';
                ids.forEach(id=>{
                    const isMe = id===myUserId;
                    const info = peers[id]||{};
                    const name = info.name||id;
                    const peerMuted = !!info.muted;
                    const showMuted = isMe ? isMuted : peerMuted;
                    const short = name.slice(-6);
                    const initial = name.replace(/[^\w\u4e00-\u9fa5]/g,'').slice(-1) || (isMe?'我':short.slice(0,1));
                    const card = document.createElement('div');
                    card.className = 'voice-peer' + (isMe?' me':'') + (showMuted ? '' : '');
                    card.id='peer-card-'+id;
                    card.innerHTML = '<div class="voice-peer-avatar">'+initial.replace('<','&lt;')+'<span class="voice-peer-mic'+(showMuted?' muted':'')+'">'+(showMuted?'🔇':'🎤')+'</span></div><div class="voice-peer-name">'+name.replace('<','&lt;')+'</div><div class="voice-peer-sub">'+(isMe?'我 · 本地': short)+(showMuted?' · 已静音':'')+' </div><div class="voice-peer-level"><div class="voice-peer-level-fill" id="peer-level-'+id+'"></div></div>';
                    voicePeersEl.appendChild(card);
                });
                // 清理离开的
                Object.keys(pcs).forEach(pid=>{
                    if(!peers[pid]){
                        try{ pcs[pid].close(); }catch(e){}
                        delete pcs[pid];
                        delete pendingIce[pid];
                        if(remoteAnalysers[pid]){
                            try{ if(remoteAnalysers[pid].raf) cancelAnimationFrame(remoteAnalysers[pid].raf); }catch(e){}
                            try{ if(remoteAnalysers[pid].src) remoteAnalysers[pid].src.disconnect(); }catch(e){}
                            delete remoteAnalysers[pid];
                        }
                        if(remoteWebAudio[pid]) disableWebAudioOutput(pid);
                        const a=document.getElementById('voice-audio-'+pid);
                        if(a) a.remove();
                    }
                });
                if(ids.length===0){
                    if(voiceHeaderPill) voiceHeaderPill.classList.add('hidden');
                }
                // 更新追踪集合（抑制标记下不触发下一帧）
                if(window._suppressVoiceToneOnce){
                    window._suppressVoiceToneOnce = false;
                    prevVoicePeerIds = new Set(ids);
                } else {
                    prevVoicePeerIds = new Set(ids);
                }
            }
            function ensureAudioEl(peerId){
                let a=document.getElementById('voice-audio-'+peerId);
                if(!a){
                    a=document.createElement('audio');
                    a.id='voice-audio-'+peerId;
                    a.autoplay=true;
                    a.controls=false;
                    a.playsInline=true;
                    // 通用：iOS 初始静音以允许自动播放，安卓/桌面初始非静音以直接走扬声器
                    a.muted = isIOSDevice ? true : false;
                    a.volume=1;
                    a.defaultMuted = a.muted;
                    a.setAttribute('playsinline','');
                    a.setAttribute('webkit-playsinline','');
                    a.setAttribute('preload','auto');
                    a.setAttribute('autoplay','');
                    // 通用：确保扬声器而非听筒，安卓 Chrome 对 x-webkit-airplay 等无害
                    try{ a.setAttribute('x-webkit-airplay','allow'); }catch(e){}
                    voiceAudios.appendChild(a);
                    voiceLog('创建 audio 元素 '+peerId.slice(-6)+' isIOS='+isIOSDevice+' muted='+a.muted);
                }
                return a;
            }
            let audioContextUnlocked=false;
            let globalAudioContext=null;
            async function unlockAudio(){
                try{
                    const AC = window.AudioContext || window.webkitAudioContext;
                    if(AC){
                        if(!globalAudioContext) globalAudioContext=new AC();
                        if(globalAudioContext.state==='suspended') await globalAudioContext.resume();
                        // 通用解锁：播放无声音频帧（iOS/安卓都有效）
                        try{
                            const buf=globalAudioContext.createBuffer(1,1,22050);
                            const srcSilent=globalAudioContext.createBufferSource();
                            srcSilent.buffer=buf; srcSilent.connect(globalAudioContext.destination); srcSilent.start(0);
                        }catch(e){}
                    }
                }catch(e){}
                // 通用尝试播放所有远端音频：先非静音（安卓/桌面），失败再静音（iOS）
                let played=0;
                for(const a of voiceAudios.querySelectorAll('audio')){
                    if(!a.srcObject) continue;
                    let ok=false;
                    // 1) 非静音直接播放（安卓通用）
                    try{
                        a.muted=false; a.volume=1;
                        await a.play();
                        ok=true; played++;
                    }catch(err){}
                    // 2) 静音播放后立刻取消静音（iOS 通用）
                    if(!ok){
                        try{
                            a.muted=true;
                            await a.play();
                            a.muted=false;
                            // iOS 需再次 play 才能出声
                            await a.play().catch(()=>{});
                            ok=true; played++;
                        }catch(err2){}
                    }
                    if(ok){
                        const b=document.getElementById('voice-audio-unlock');
                        if(b) b.remove();
                        // 若之前启用了 WebAudio 兜底且 HTMLAudio 已成功，关闭兜底避免双声
                        const pid=a.id.replace('voice-audio-','');
                        if(remoteWebAudio[pid]){ disableWebAudioOutput(pid); voiceLog('HTMLAudio 成功，关闭 WebAudio 兜底 '+pid.slice(-6)); }
                    } else {
                        // HTMLAudio 仍失败，启用 WebAudio 兜底保证扬声器有声（安卓/第三方浏览器）
                        const pid=a.id.replace('voice-audio-','');
                        if(a.srcObject && !remoteWebAudio[pid]) enableWebAudioOutput(pid, a.srcObject);
                    }
                }
                if(!audioContextUnlocked){
                    audioContextUnlocked=true;
                    voiceLog('音频已解锁 context='+(globalAudioContext?globalAudioContext.state:'none')+' 已播放 '+played+' 路 isIOS='+isIOSDevice);
                } else if(played>0){
                    voiceLog('音频再次解锁 已播放 '+played+' 路 context='+(globalAudioContext?globalAudioContext.state:'none'));
                }
                // 若仍有未播放的，保留按钮但文案通用
                const hasPending = Array.from(voiceAudios.querySelectorAll('audio')).some(x=> x.srcObject && x.paused);
                if(hasPending && !document.getElementById('voice-audio-unlock')){
                    const b=document.createElement('button');
                    b.id='voice-audio-unlock';
                    b.textContent='🔊 点击开启扬声器';
                    b.style.cssText='position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9999;padding:14px 20px;border-radius:12px;border:none;background:#3B82F6;color:#fff;font-weight:800;box-shadow:0 8px 24px rgba(0,0,0,0.28);font-size:0.95rem';
                    b.onclick=async ()=>{ b.remove(); await unlockAudio(); };
                    document.body.appendChild(b);
                    setTimeout(()=>{ try{b.remove();}catch(e){} }, 15000);
                }
            }
            document.addEventListener('touchend', ()=>{ unlockAudio(); }, {passive:true});
            document.addEventListener('click', ()=>{ unlockAudio(); }, {passive:true});
            document.addEventListener('touchstart', ()=>{ if(globalAudioContext && globalAudioContext.state==='suspended') globalAudioContext.resume().catch(()=>{}); }, {passive:true});
            document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible' && globalAudioContext && globalAudioContext.state==='suspended') globalAudioContext.resume().catch(()=>{}); });

            function sendRtcSignal(type, target, payload){
                if(useWS && ws && ws.readyState===1){
                    try{
                        if(type==='join') ws.send(JSON.stringify({type:'join', room: rtcRoomId, userId: myUserId, name: rtcUserName}));
                        else if(type==='leave') ws.send(JSON.stringify({type:'leave'}));
                        else if(type==='heartbeat') ws.send(JSON.stringify({type:'heartbeat'}));
                        else ws.send(JSON.stringify({type:'signal', kind:type, to: target||'', payload: payload||''}));
                        voiceLog('发送 '+type+(target?' -> '+target.slice(-6):''));
                        return Promise.resolve({status:'success'});
                    }catch(e){ voiceLog('WS 发送失败回退 PHP '+e.message); }
                }
                const fd=new FormData();
                fd.append('action','rtc_signal');
                fd.append('rtc_type',type);
                fd.append('target',target||'');
                fd.append('payload',payload||'');
                return fetch('',{method:'POST',body:fd}).then(r=>r.json()).catch(()=>null);
            }
            function createPC(peerId){
                if(pcs[peerId]) return pcs[peerId];
                voiceLog('创建 PC '+peerId.slice(-6));
                const pc=new RTCPeerConnection({iceServers:rtcIceServers, sdpSemantics:'unified-plan'});
                pcs[peerId]=pc;
                pendingIce[peerId]=[];
                if(localStream){
                    localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));
                    voiceLog('已添加本地轨道 '+localStream.getTracks().length+' 到 '+peerId.slice(-6));
                } else {
                    try{ pc.addTransceiver('audio', {direction:'recvonly'}); }catch(e){}
                }
                pc.onicecandidate=e=>{
                    if(e.candidate){
                        voiceLog('ICE -> '+peerId.slice(-6));
                        sendRtcSignal('ice', peerId, JSON.stringify(e.candidate));
                    } else {
                        voiceLog('ICE 收集完成 '+peerId.slice(-6));
                    }
                };
                pc.ontrack=e=>{
                    voiceLog('收到远端轨道 '+peerId.slice(-6)+' streams:'+e.streams.length+' track muted='+e.track.muted+' enabled='+e.track.enabled);
                    const a=ensureAudioEl(peerId);
                    a.srcObject=e.streams[0];
                    a.volume=1;
                    a.muted = isIOSDevice ? true : false;
                    try{
                        if(globalAudioContext && globalAudioContext.state==='suspended') globalAudioContext.resume();
                    }catch(err){}
                    // 远端音量分析 用于头像闪动
                    try{
                        if(globalAudioContext){
                            const srcR = globalAudioContext.createMediaStreamSource(e.streams[0]);
                            const anaR = globalAudioContext.createAnalyser();
                            anaR.fftSize=256;
                            anaR.smoothingTimeConstant=0.7;
                            srcR.connect(anaR);
                            const dataR=new Uint8Array(anaR.fftSize);
                            remoteAnalysers[peerId]={analyser:anaR, data:dataR, src:srcR};
                            const loopR=()=>{
                                if(!pcs[peerId] || !remoteAnalysers[peerId]) return;
                                anaR.getByteTimeDomainData(dataR);
                                let sumSq=0; for(let i=0;i<dataR.length;i++){ const v=(dataR[i]-128)/128; sumSq+=v*v; }
                                const rms=Math.sqrt(sumSq/dataR.length);
                                const pct=Math.min(100, Math.round(rms*280));
                                const fill=document.getElementById('peer-level-'+peerId);
                                if(fill) fill.style.width=pct+'%';
                                const card=document.getElementById('peer-card-'+peerId);
                                if(card){
                                    if(pct>10) card.classList.add('speaking'); else card.classList.remove('speaking');
                                    const av=card.querySelector('.voice-peer-avatar');
                                    if(av){ if(pct>10) av.classList.add('speaking'); else av.classList.remove('speaking'); }
                                }
                                remoteAnalysers[peerId].raf=requestAnimationFrame(loopR);
                            };
                            loopR();
                        }
                    }catch(err){ voiceLog('远端分析失败 '+peerId.slice(-6)+' '+err.message); }
                    const tryPlay=async ()=>{
                        try{ if(globalAudioContext && globalAudioContext.state==='suspended') await globalAudioContext.resume(); }catch(err){}
                        // 通用双路径：安卓/桌面优先非静音，iOS 需静音后解锁；并用 WebAudio 兜底保证扬声器
                        let htmlOk=false;
                        if(!isIOSDevice){
                            // 1) 安卓/桌面：直接非静音播放（扬声器直通）
                            try{
                                a.muted=false; a.volume=1;
                                await a.play();
                                voiceLog('播放成功(非静音) '+peerId.slice(-6));
                                htmlOk=true;
                            }catch(err){ voiceLog('非静音播放受限 '+peerId.slice(-6)+' '+(err.message||err.name)); }
                        }
                        if(!htmlOk){
                            // 2) 通用/iOS：静音播放后解锁取消静音
                            try{
                                a.muted=true;
                                await a.play();
                                voiceLog('静音播放成功 '+peerId.slice(-6)+' paused='+a.paused);
                                try{
                                    await unlockAudio();
                                    a.muted=false;
                                    try{ await a.play(); }catch(e){}
                                    voiceLog('已取消静音 '+peerId.slice(-6)+' muted='+a.muted);
                                    htmlOk=!a.paused;
                                }catch(e){ voiceLog('取消静音失败 '+e.message); }
                            }catch(err){
                                voiceLog('静音播放被拦截 '+peerId.slice(-6)+' '+(err.message||err.name));
                            }
                        }
                        if(htmlOk){
                            if(voiceDebugEl) voiceDebugEl.textContent='✓ 正在通话 '+peerId.slice(-6);
                            const b=document.getElementById('voice-audio-unlock');
                            if(b) b.remove();
                            if(remoteWebAudio[peerId]){ disableWebAudioOutput(peerId); }
                            return;
                        }
                        // 3) 仍失败：启用 WebAudio 扬声器兜底（安卓/iOS 通用，绕过 HTMLAudio 自动播放限制）
                        try{
                            if(enableWebAudioOutput(peerId, e.streams[0])){
                                voiceLog('WebAudio 兜底已接管 '+peerId.slice(-6)+' 请检查是否已出声');
                                // 引导用户再次手势以提升成功率
                                try{ await unlockAudio(); }catch(e){}
                            }
                        }catch(e){}
                        // 4) 显示通用手势按钮（文案去 iOS 定制，适配所有浏览器）
                        if(!document.getElementById('voice-audio-unlock')){
                            const b=document.createElement('button');
                            b.id='voice-audio-unlock';
                            b.textContent='🔊 点击开启扬声器';
                            b.style.cssText='position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9999;padding:14px 22px;border-radius:12px;border:none;background:#3B82F6;color:#fff;font-weight:800;box-shadow:0 8px 24px rgba(0,0,0,0.28);font-size:0.96rem';
                            b.onclick=async ()=>{
                                b.remove();
                                await unlockAudio();
                                for(const el of voiceAudios.querySelectorAll('audio')){
                                    if(el.srcObject){
                                        try{
                                            el.muted=false; el.volume=1;
                                            await el.play();
                                            const pid2=el.id.replace('voice-audio-','');
                                            if(remoteWebAudio[pid2]) disableWebAudioOutput(pid2);
                                        }catch(e){}
                                    }
                                }
                            };
                            document.body.appendChild(b);
                            setTimeout(()=>{ try{b.remove();}catch(e){} }, 15000);
                        }
                    };
                    setTimeout(tryPlay, 60);
                    e.streams[0].onaddtrack=()=> voiceLog('流 addtrack '+peerId.slice(-6));
                    e.track.onunmute=()=>{ voiceLog('远端 track onunmute '+peerId.slice(-6)); setTimeout(tryPlay, 30); };
                    e.track.onmute=()=> voiceLog('远端 track onmute '+peerId.slice(-6));
                };
                let iceFailedTimer = null;
                pc.onconnectionstatechange=()=>{
                    voiceLog('PC '+peerId.slice(-6)+' connectionState '+pc.connectionState);
                    if(pc.connectionState==='connected'){
                        setVoiceStatus('通话中','connected');
                        if(iceFailedTimer){ clearTimeout(iceFailedTimer); iceFailedTimer=null; }
                    } else if(pc.connectionState==='failed' || pc.connectionState==='disconnected'){
                        if(iceFailedTimer) clearTimeout(iceFailedTimer);
                        iceFailedTimer = setTimeout(()=>{
                            if(!pcs[peerId] || pcs[peerId].connectionState==='connected') return;
                            voiceLog('PC 长时失败，判定掉线 '+peerId.slice(-6));
                            try{ pcs[peerId].close(); }catch(e){}
                            delete pcs[peerId];
                            delete pendingIce[peerId];
                            if(remoteAnalysers[peerId]){ try{ remoteAnalysers[peerId].src.disconnect(); }catch(e){} delete remoteAnalysers[peerId]; }
                            if(remoteWebAudio[peerId]) disableWebAudioOutput(peerId);
                            const av=document.getElementById('voice-audio-'+peerId); if(av){ try{av.srcObject=null;}catch(e){} av.remove(); }
                            // 1.5s 内无 relay 重建仍失败则视为人员掉线，立即提示音
                            if(pcs[peerId]===undefined){
                                try{ playLeaveSound(); voiceLog('🔕 对方掉线（P2P 断连）'); }catch(e){}
                                setVoiceStatus('通话中','connected');
                            }
                        }, 1500);
                    } else if(pc.connectionState==='closed'){
                        if(iceFailedTimer){ clearTimeout(iceFailedTimer); iceFailedTimer=null; }
                    }
                };
                pc.oniceconnectionstatechange=()=>{
                    voiceLog('PC '+peerId.slice(-6)+' iceState '+pc.iceConnectionState);
                    if(pc.iceConnectionState==='failed'){
                        try{ pc.restartIce(); }catch(e){}
                        if(!iceFailedTimer){
                            iceFailedTimer = setTimeout(()=>{
                                if(!pcs[peerId]) return;
                                if(pcs[peerId].iceConnectionState==='failed'){
                                    try{ playLeaveSound(); voiceLog('🔕 对方掉线（ICE 失败）'); }catch(e){}
                                }
                            }, 2200);
                        }
                    } else if(pc.iceConnectionState==='connected' || pc.iceConnectionState==='completed'){
                        if(iceFailedTimer){ clearTimeout(iceFailedTimer); iceFailedTimer=null; }
                    }
                };
                pc.onsignalingstatechange=()=>{
                    voiceLog('PC '+peerId.slice(-6)+' signaling '+pc.signalingState);
                };
                return pc;
            }
            async function handleRtcSignals(signals){
                for(const s of signals){
                    const from=s.from, type=s.type;
                    if(!from) continue;
                    if(type==='leave'){
                        voiceLog('对方离开 '+from.slice(-6));
                        if(pcs[from]){ try{pcs[from].close();}catch(e){} delete pcs[from]; delete pendingIce[from]; }
                        if(remoteAnalysers[from]){ try{ remoteAnalysers[from].src.disconnect(); }catch(e){} delete remoteAnalysers[from]; }
                        if(remoteWebAudio[from]) disableWebAudioOutput(from);
                        const a=document.getElementById('voice-audio-'+from);
                        if(a){ try{ a.srcObject=null; }catch(e){} a.remove(); }
                        if(voiceAudios.children.length===0) voiceAudios.classList.remove('has-audio');
                        // 立即提示音（不等 peers 广播）
                        try{ if(!from.startsWith('__')){ playLeaveSound(); voiceLog('🔕 对方离开/掉线'); }}catch(e){}
                        continue;
                    }
                    let payloadObj=null;
                    try{ payloadObj = s.payload ? JSON.parse(s.payload) : null; }catch(e){ voiceLog('payload 解析失败 '+from.slice(-6)); continue; }
                    if(type==='offer'){
                        voiceLog('收到 offer '+from.slice(-6));
                        const pc=createPC(from);
                        try{
                            await pc.setRemoteDescription(new RTCSessionDescription(payloadObj));
                            if(pendingIce[from] && pendingIce[from].length){
                                for(const c of pendingIce[from]){ try{ await pc.addIceCandidate(new RTCIceCandidate(c)); }catch(e){} }
                                pendingIce[from]=[];
                            }
                            const answer=await pc.createAnswer();
                            await pc.setLocalDescription(answer);
                            await sendRtcSignal('answer', from, JSON.stringify(pc.localDescription));
                            voiceLog('已发送 answer -> '+from.slice(-6));
                        }catch(e){ voiceLog('处理 offer 失败 '+e.message); }
                    } else if(type==='answer'){
                        voiceLog('收到 answer '+from.slice(-6));
                        const pc=pcs[from];
                        if(!pc){ voiceLog('answer 但无 PC '+from.slice(-6)); continue; }
                        try{
                            await pc.setRemoteDescription(new RTCSessionDescription(payloadObj));
                            if(pendingIce[from] && pendingIce[from].length){
                                for(const c of pendingIce[from]){ try{ await pc.addIceCandidate(new RTCIceCandidate(c)); }catch(e){} }
                                pendingIce[from]=[];
                            }
                        }catch(e){ voiceLog('处理 answer 失败 '+e.message); }
                    } else if(type==='ice'){
                        const pc=pcs[from];
                        if(!pc){
                            if(!pendingIce[from]) pendingIce[from]=[];
                            pendingIce[from].push(payloadObj);
                            voiceLog('缓存 ICE '+from.slice(-6)+' (PC 未就绪)');
                            continue;
                        }
                        if(!pc.remoteDescription || !pc.remoteDescription.type){
                            if(!pendingIce[from]) pendingIce[from]=[];
                            pendingIce[from].push(payloadObj);
                            voiceLog('缓存 ICE '+from.slice(-6)+' (remoteDescription 未就绪)');
                            continue;
                        }
                        try{ await pc.addIceCandidate(new RTCIceCandidate(payloadObj)); voiceLog('添加 ICE '+from.slice(-6)); }catch(e){ voiceLog('ICE 添加失败 '+e.message); }
                    }
                }
            }
            async function doOfferForNewPeers(peers){
                for(const pid of Object.keys(peers)){
                    if(pid===myUserId) continue;
                    if(myUserId < pid && !pcs[pid]){
                        voiceLog('发起 offer -> '+pid.slice(-6));
                        const pc=createPC(pid);
                        try{
                            const offer=await pc.createOffer({offerToReceiveAudio:true, offerToReceiveVideo:false});
                            await pc.setLocalDescription(offer);
                            await sendRtcSignal('offer', pid, JSON.stringify(pc.localDescription));
                            voiceLog('已发送 offer -> '+pid.slice(-6));
                        }catch(e){ voiceLog('创建 offer 失败 '+e.message); }
                    }
                }
            }
            async function pollRtc(){
                if(useWS && wsReady){ return; }
                const fd=new FormData(); fd.append('action','rtc_poll');
                try{
                    const res=await fetch('',{method:'POST',body:fd});
                    const data=await res.json();
                    if(data && data.status==='success'){
                        renderVoicePeers(data.peers||{});
                        if(data.signals && data.signals.length) await handleRtcSignals(data.signals);
                        await doOfferForNewPeers(data.peers||{});
                    }
                }catch(e){ voiceLog('poll 失败 '+e.message); }
            }
            async function pollRtcOnceAndOffer(peers){
                await doOfferForNewPeers(peers||{});
            }
            async function joinVoice(){
                if(isInVoice) return;
                if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
                    alert('当前浏览器不支持麦克风，请用 Chrome/Edge/Safari 最新版（iOS 需 Safari，Android 需 Chrome）');
                    return;
                }
                // iOS：必须在用户点击同步阶段就创建/恢复 AudioContext，否则后续远端播放会被拦截
                try{ await unlockAudio(); }catch(e){}
                if(!globalAudioContext){
                    try{
                        const AC=window.AudioContext||window.webkitAudioContext;
                        if(AC){ globalAudioContext=new AC(); if(globalAudioContext.state==='suspended') await globalAudioContext.resume();
                            try{ const buf=globalAudioContext.createBuffer(1,1,22050); const s=globalAudioContext.createBufferSource(); s.buffer=buf; s.connect(globalAudioContext.destination); s.start(0);}catch(e){}
                        }
                    }catch(e){}
                } else if(globalAudioContext.state==='suspended'){
                    try{ await globalAudioContext.resume(); }catch(e){}
                }
                try{
                    setVoiceStatus('连接中…','connecting');
                    if(voiceJoinBtn){ voiceJoinBtn.disabled=true; voiceJoinBtn.innerHTML='<span class="vj-icon">⏳</span><span class="vj-text">连接中…</span>'; }
                    let stream=null;
                    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
                    const acConstraints = isIOS ? {echoCancellation:true,noiseSuppression:true,autoGainControl:true, sampleRate:48000} : {echoCancellation:{ideal:true},noiseSuppression:{ideal:true},autoGainControl:{ideal:true}, channelCount:{ideal:1}};
                    try{
                        stream=await navigator.mediaDevices.getUserMedia({audio:acConstraints,video:false});
                    }catch(err){
                        voiceLog('高级约束失败，回退 audio:true '+err.message+' isIOS='+isIOS);
                        stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
                    }
                    localStream=stream;
                    const at = localStream.getAudioTracks()[0];
                    if(at){
                        try{ voiceLog('麦克风设备 label='+at.label+' settings='+JSON.stringify(at.getSettings())); }catch(e){ voiceLog('麦克风已获取 tracks:'+stream.getTracks().length+' label='+at.label); }
                    } else {
                        voiceLog('麦克风已获取 tracks:'+stream.getTracks().length+' 但无 audioTrack!');
                    }
                    localStream.getAudioTracks().forEach(t=>{ t.enabled=!isMuted; voiceLog('本地轨道 enabled '+t.enabled+' muted '+t.muted+' readyState '+t.readyState); });
                    // 头像说话闪动 - 轻量本地分析（仅驱动头像，不显示音量条，三端兼容）
                    try{
                        const AC = window.AudioContext || window.webkitAudioContext;
                        if(!globalAudioContext){
                            globalAudioContext=new AC();
                            if(globalAudioContext.state==='suspended') await globalAudioContext.resume();
                        } else if(globalAudioContext.state==='suspended'){
                            await globalAudioContext.resume();
                        }
                        if(globalAudioContext){
                            const src = globalAudioContext.createMediaStreamSource(localStream);
                            localAnalyser = globalAudioContext.createAnalyser();
                            localAnalyser.fftSize=512;
                            localAnalyser.smoothingTimeConstant=0.65;
                            src.connect(localAnalyser);
                            localAnalyserData=new Uint8Array(localAnalyser.fftSize);
                            const loop=()=>{
                                if(!isInVoice || !localAnalyser){ if(levelRaf) cancelAnimationFrame(levelRaf); return; }
                                localAnalyser.getByteTimeDomainData(localAnalyserData);
                                let sumSq=0; for(let i=0;i<localAnalyserData.length;i++){ const v=(localAnalyserData[i]-128)/128; sumSq+=v*v; }
                                const rms=Math.sqrt(sumSq/localAnalyserData.length);
                                const pct=Math.min(100, Math.round(rms*320));
                                const meCard=document.getElementById('peer-card-'+myUserId);
                                if(meCard){
                                    if(pct>10 && !isMuted) meCard.classList.add('speaking');
                                    else meCard.classList.remove('speaking');
                                    const av=meCard.querySelector('.voice-peer-avatar');
                                    if(av){ if(pct>10 && !isMuted) av.classList.add('speaking'); else av.classList.remove('speaking'); }
                                }
                                levelRaf=requestAnimationFrame(loop);
                            };
                            loop();
                        }
                    }catch(e){ voiceLog('头像闪动分析失败 '+e.message); }
                    // 若已有PC但当时无本地流，补加发送端并重协商（修复PC/安卓加入后无声）
                    try{
                        for(const pid of Object.keys(pcs)){
                            const pc=pcs[pid];
                            const senders=pc.getSenders();
                            const hasAudio=senders.some(s=> s.track && s.track.kind==='audio');
                            if(!hasAudio){
                                voiceLog('补加本地轨道到已有PC '+pid.slice(-6));
                                localStream.getAudioTracks().forEach(tr=> pc.addTrack(tr, localStream));
                                const offer=await pc.createOffer({offerToReceiveAudio:true});
                                await pc.setLocalDescription(offer);
                                await sendRtcSignal('offer', pid, JSON.stringify(pc.localDescription));
                            } else {
                                // 已有发送端，替换轨道以确保是最新流
                                const sender=senders.find(s=> s.track && s.track.kind==='audio');
                                if(sender && sender.replaceTrack){
                                    try{ await sender.replaceTrack(localStream.getAudioTracks()[0]); voiceLog('已 replaceTrack -> '+pid.slice(-6)); }catch(err){ voiceLog('replaceTrack 失败 '+err.message); }
                                }
                            }
                        }
                    }catch(e){ voiceLog('补加轨道失败 '+e.message); }
                    isInVoice=true; isMuted=false;
                    if(voiceMuteBtn) voiceMuteBtn.textContent='🎤 麦克风开';
                    if(voiceBar) voiceBar.classList.remove('hidden');
                    setVoiceStatus('通话中','connected');
                    if(voiceJoinBtn){ voiceJoinBtn.innerHTML='<span class="vj-icon">●</span><span class="vj-text">通话中</span>'; voiceJoinBtn.classList.add('joined'); voiceJoinBtn.disabled=false; voiceJoinBtn.title='点击挂断'; }
                    const joinRes=await sendRtcSignal('join','','');
                    if(joinRes && joinRes.peers) renderVoicePeers(joinRes.peers);
                    if(useWS && wsReady){
                        rtcPollTimer=null;
                    } else {
                        pollRtc();
                        rtcPollTimer=setInterval(pollRtc, 1200);
                    }
                    rtcHeartbeatTimer=setInterval(()=>{ try{ if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'heartbeat'})); else sendRtcSignal('heartbeat','',''); }catch(e){ sendRtcSignal('heartbeat','',''); } }, 7000);
                    try{ unlockAudio(); }catch(e){}
                    setTimeout(()=>{ if(isInVoice && !useWS && !rtcPollTimer){ rtcPollTimer=setInterval(pollRtc, 1200); } }, 2500);
                    if(voiceMuteBtn) voiceMuteBtn.disabled=false;
                    voiceLog('加入语音完成，等待对方...');
                }catch(e){
                    console.error(e);
                    voiceLog('getUserMedia 失败 '+(e.name||'')+' '+(e.message||''));
                    setVoiceStatus('未加入','idle');
                    if(voiceJoinBtn){ voiceJoinBtn.innerHTML='<span class="vj-icon">🎙️</span><span class="vj-text">加入语音</span>'; voiceJoinBtn.classList.remove('joined'); voiceJoinBtn.disabled=false; voiceJoinBtn.title='加入实时语音'; }
                    let msg='无法访问麦克风：'+(e.message||e.name||'未知');
                    if(e.name==='NotAllowedError') msg='麦克风权限被拒绝，请在浏览器设置中允许 chat.lkz.pub 访问麦克风，然后刷新重试（iOS 需在设置>Safari>麦克风）';
                    else if(e.name==='NotFoundError') msg='未找到麦克风设备';
                    else if(location.protocol!=='https:') msg='语音通话需要 HTTPS，请用 https://chat.lkz.pub 访问';
                    alert(msg);
                    if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
                    if(voiceBar) voiceBar.classList.add('hidden');
                    isInVoice=false;
                    voiceLog('getUserMedia 异常结束');
                }
            }
            function leaveVoice(){
                voiceLog('离开语音 isInVoice='+isInVoice+' hasStream='+(!!localStream));
                if(!isInVoice && !localStream) return;
                isInVoice=false;
                if(rtcPollTimer){ clearInterval(rtcPollTimer); rtcPollTimer=null; }
                if(rtcHeartbeatTimer){ clearInterval(rtcHeartbeatTimer); rtcHeartbeatTimer=null; }
                sendRtcSignal('leave','','');
                Object.values(pcs).forEach(pc=>{ try{pc.close();}catch(e){} });
                pcs={};
                pendingIce={};
                if(voiceAudios) voiceAudios.innerHTML='';
                if(localStream){ try{ localStream.getTracks().forEach(t=>t.stop()); }catch(e){} localStream=null; }
                if(voiceBar) voiceBar.classList.add('hidden');
                setVoiceStatus('未加入','idle');
                if(voiceJoinBtn){ voiceJoinBtn.innerHTML='<span class="vj-icon">🎙️</span><span class="vj-text">加入语音</span>'; voiceJoinBtn.classList.remove('joined'); }
                renderVoicePeers({});
                if(levelRaf){ cancelAnimationFrame(levelRaf); levelRaf=null; }
                if(localAnalyser){ try{ localAnalyser.disconnect(); }catch(e){} localAnalyser=null; }
                voiceLog('已离开');
            }
            if(voiceJoinBtn){
                voiceJoinBtn.addEventListener('click', ()=>{
                    voiceLog('点击按钮 isInVoice='+isInVoice+' audioUnlocked='+audioContextUnlocked+' wsReady='+wsReady);
                    if(isInVoice) leaveVoice(); else joinVoice();
                });
            } else {
                voiceLog('voiceJoinBtn 未找到!');
            }
            if(voiceLeaveBtn) voiceLeaveBtn.addEventListener('click', ()=>{ voiceLog('点击挂断'); leaveVoice(); });
            if(voiceMuteBtn) voiceMuteBtn.addEventListener('click', ()=>{
                if(!localStream){ voiceLog('静音失败 无本地流'); return; }
                isMuted=!isMuted;
                localStream.getAudioTracks().forEach(t=> t.enabled=!isMuted);
                voiceMuteBtn.innerHTML = isMuted ? '<span>🔇</span><span class="vc-text">已静音</span>' : '<span>🎤</span><span class="vc-text">麦克风开</span>';
                voiceMuteBtn.classList.toggle('muted', isMuted);
                const mic=document.querySelector('#peer-card-'+myUserId+' .voice-peer-mic');
                if(mic){ mic.textContent=isMuted?'🔇':'🎤'; mic.classList.toggle('muted', isMuted); }
                const sub=document.querySelector('#peer-card-'+myUserId+' .voice-peer-sub');
                if(sub) sub.textContent = isMuted ? '我 · 已静音' : '我 · 本地';
                // 广播静音状态给所有人
                try{
                    const payload = JSON.stringify({muted:isMuted});
                    if(useWS && ws && ws.readyState===1){
                        ws.send(JSON.stringify({type:'mute', muted:isMuted, payload:payload}));
                    } else {
                        sendRtcSignal('mute','',''+payload);
                    }
                }catch(e){}
                // 本地 also update server via fallback to ensure peers polling sees it
                sendRtcSignal('mute','',''+JSON.stringify({muted:isMuted}));
                voiceLog(isMuted?'已静音 已广播':'已取消静音 已广播');
            });
            window.addEventListener('beforeunload', ()=>{
                if(isInVoice){
                    try{ navigator.sendBeacon('', new URLSearchParams({action:'rtc_signal',rtc_type:'leave'})); }catch(e){}
                    try{ if(ws && ws.readyState===1) ws.send(JSON.stringify({type:'leave'})); }catch(e){}
                }
            });

            // 定期获取新消息
            const messagePolling = setInterval(fetchMessages, 2000); // 每2秒获取一次新消息
            
            // 定期检查创建者状态
            const creatorPolling = setInterval(checkCreatorStatus, 5000); // 每5秒检查一次创建者状态
            
            // 定期检查聊天是否存在
            setInterval(function() {
                const formData = new FormData();
                formData.append('action', 'check_chat_exists');
                
                fetch('', {
                    method: 'POST',
                    body: formData,
                    cache: 'no-store'
                })
                .then(response => response.json())
                .then(data => {
                    if (!data.exists) {
                        // 聊天已被删除或过期
                        showDeletedNotice();
                    }
                })
                .catch(error => console.error('检查聊天状态错误:', error));
            }, 5000); // 每5秒检查一次
        });
        
        // 图片模态框功能
        function openImageModal(src, sender) {
            const modal = document.getElementById('imageModal');
            const modalImg = document.getElementById('modalImage');
            const captionText = document.getElementById('modalCaption');
            
            modal.style.display = '';
            modal.classList.add('open');
            modalImg.src = src;
            captionText.innerHTML = `由 ${sender} 发送`;
            
            // 点击模态框背景关闭
            modal.addEventListener('click', function(e) {
                if (e.target === modal) {
                    closeImageModal();
                }
            });
            
            // ESC键关闭
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') {
                    closeImageModal();
                }
            });
            
            // 触摸滑动关闭（移动端）
            let startY = 0;
            modal.addEventListener('touchstart', function(e) {
                startY = e.touches[0].clientY;
            });
            
            modal.addEventListener('touchmove', function(e) {
                const currentY = e.touches[0].clientY;
                if (currentY - startY > 100) { // 向下滑动超过100px关闭
                    closeImageModal();
                }
            });
        }
        
        function closeImageModal() {
            const modal = document.getElementById('imageModal');
            const modalImg = document.getElementById('modalImage');
            if (modal) {
                modal.classList.remove('open');
                modal.style.display = 'none';
            }
            if (modalImg) modalImg.src = '';
        }
    </script>
</body>
</html>