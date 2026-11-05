#include "sound.h"

#include <windows.h>

#include <mmsystem.h>

namespace {

bool g_ringing = false;

}  // namespace

void PlayMessageSound() {
  // 来电响铃时不叠新消息音，避免两路声音混在一起
  if (g_ringing) return;

  // 优先用系统「通知」音；老系统没有该别名时回退到标准提示音。
  // SND_NODEFAULT 的缺失是刻意的：别名不存在时必须回退，不能静默。
  if (!PlaySoundW(L"Notification.Default", nullptr,
                  SND_ALIAS | SND_ASYNC | SND_NOWAIT)) {
    PlaySoundW(L"SystemNotification", nullptr,
               SND_ALIAS | SND_ASYNC | SND_NOWAIT);
  }
}

void StartRingtone() {
  if (g_ringing) return;
  g_ringing = true;

  // SND_LOOP 必须配合 SND_ASYNC。
  // 别名优先选「电话振铃」，退化到「感叹号」再退化到「通知」。
  if (!PlaySoundW(L"SystemHand", nullptr,
                  SND_ALIAS | SND_ASYNC | SND_LOOP | SND_NOWAIT)) {
    if (!PlaySoundW(L"Ring06.wav", nullptr,
                    SND_ALIAS | SND_ASYNC | SND_LOOP | SND_NOWAIT)) {
      PlaySoundW(L"SystemExclamation", nullptr,
                 SND_ALIAS | SND_ASYNC | SND_LOOP | SND_NOWAIT);
    }
  }
}

void StopRingtone() {
  if (!g_ringing) return;
  g_ringing = false;
  // 传 nullptr 即为停止当前播放
  PlaySoundW(nullptr, nullptr, 0);
}

bool IsRingtonePlaying() { return g_ringing; }
