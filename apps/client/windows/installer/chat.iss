; ============================================================
; Chat for Windows — Inno Setup 安装脚本
; ------------------------------------------------------------
; 为什么用 Inno Setup 而不是 MSIX：
;   1. MSIX 需要代码签名证书才能在普通用户机器上安装（否则被 SmartScreen
;      拦截且无法绕过），而我们没有签名证书；
;   2. Inno Setup 产出的单文件 .exe 双击即装，符合国内用户习惯；
;   3. Inno Setup 在 GitHub Actions 的 windows-latest 镜像里**预装**，
;      不需要额外下载安装，CI 零成本。
;
; 构建：
;   ISCC.exe /DAppVersion=3.0.1 installer\chat.iss
;   产物 output\chat-3.0.1-setup.exe
;
; 说明：以管理员权限安装到 Program Files，卸载走系统的「应用和功能」。
; ============================================================

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#define AppName "Chat"
#define AppPublisher "chat.lkz.pub"
#define AppExeName "chat.exe"

[Setup]
AppId={{8F3B21C4-6D1E-4E77-9A11-1B2C3D4E5F60}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://chat.lkz.pub
AppSupportURL=https://chat.lkz.pub
AppUpdatesURL=https://chat.lkz.pub

; 默认装到 Program Files，用户级 PATH 不需要
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}

; 输出
OutputDir=..\..\build\windows\installer
OutputBaseFilename=chat-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes

; 64 位应用，装到 64 位 Program Files
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; 需要管理员权限：写入 Program Files
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog

; 现代化向导外观
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Default.isl"
Name: "english"; MessagesFile: "compiler:Languages\English.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Flutter 构建输出（exe + 依赖 dll + data 目录）整体打包
Source: "..\..\build\windows\x64\runner\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; VC++ 运行库由 flutter 构建产物里的 msvcp140.dll 等一并打包，无需额外检测

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
; 安装完成后可选直接启动
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 应用运行时会写缓存到 %LOCALAPPDATA%\Chat，卸载时一并清理
Type: filesandordirs; Name: "{localappdata}\Chat"
