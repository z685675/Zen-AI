!ifndef ZEN_INSTALLER_PROCESS_INCLUDED
!define ZEN_INSTALLER_PROCESS_INCLUDED

!ifndef BUILD_UNINSTALLER
Function waitForUpdateParent
  Push $0
  Push $1
  Push $2
  ReadEnvStr $0 "ZEN_AI_UPDATE_PARENT_PID"
  ${If} $0 != ""
    ; The updater starts NSIS before Electron's bounded service/database cleanup
    ; completes. Wait on the process handle, not a fixed sleep or an image name.
    System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i r0) p.r1'
    ${If} $1 P<> 0
      DetailPrint "Waiting for the previous Zen AI process to exit..."
      System::Call 'kernel32::WaitForSingleObject(p r1, i 30000) i.r2'
      System::Call 'kernel32::CloseHandle(p r1)'
      ${If} $2 != 0
        DetailPrint "Previous process did not exit in time; checking remaining application processes."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

!macro ZenCloseFailureMessage OUTPUT
  ; NSIS language IDs: Simplified Chinese and Traditional Chinese; use English
  ; for the remaining installer languages without incomplete LangString tables.
  ${If} $LANGUAGE == 2052
    StrCpy ${OUTPUT} "未能完全关闭旧版 Zen AI。请从系统托盘中退出软件后点击“重试”。点击“取消”可退出安装，当前版本和数据会保留。"
  ${ElseIf} $LANGUAGE == 1028
    StrCpy ${OUTPUT} "未能完全關閉舊版 Zen AI。請從系統匣中結束軟體後點擊「重試」。點擊「取消」可結束安裝，目前版本和資料會保留。"
  ${Else}
    StrCpy ${OUTPUT} "Zen AI could not finish closing. Exit the application from its system tray menu and click Retry. Cancel leaves the current version and your data unchanged."
  ${EndIf}
!macroend

!macro ZenCloseRunningProcesses PREFIX
Function ${PREFIX}closeRunningZenAI
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $3 "2"
  ClearErrors
  ${GetOptions} $CMDLINE "--updated" $2
  ${IfNot} ${Errors}
    ; Older clients do not send the PID marker. Allow their bounded cleanup
    ; to finish as well; do not force-close a still-flushing database.
    ReadEnvStr $2 "ZEN_AI_UPDATE_PARENT_PID"
    ${If} $2 == ""
      StrCpy $3 "30"
    ${EndIf}
  ${EndIf}
  InitPluginsDir
  File /oname=$PLUGINSDIR\zen-close-running-app.ps1 "${BUILD_RESOURCES_DIR}\close-running-app.ps1"
  System::Call 'kernel32::GetCurrentProcessId() i.r2'
  ; NSIS runs as a 32-bit process, so $SYSDIR normally redirects to SysWOW64.
  ; Prefer the native host without changing redirection for other installer work.
  StrCpy $4 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $4 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  retryCleanup:
  nsExec::ExecToStack /TIMEOUT=45000 '"$4" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\zen-close-running-app.ps1" -InstallDirectory "$INSTDIR" -InstallerPid $2 -GracePeriodSeconds $3'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    DetailPrint "Application process cleanup returned $0; existing application files have not been replaced."
    !insertmacro ZenCloseFailureMessage $1
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$1" /SD IDCANCEL IDRETRY retryCleanup
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
    Abort
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend
!endif
