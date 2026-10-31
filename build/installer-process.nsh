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

!macro ZenCloseRunningProcesses PREFIX
Function ${PREFIX}closeRunningZenAI
  Push $0
  Push $1
  Push $2
  Push $3
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
  retryCleanup:
  nsExec::ExecToStack /TIMEOUT=45000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\zen-close-running-app.ps1" -InstallDirectory "$INSTDIR" -InstallerPid $2 -GracePeriodSeconds $3'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    DetailPrint "Application process cleanup returned $0; existing application files have not been replaced."
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Zen AI could not finish closing. Close the application and click Retry, or Cancel to leave the current installation unchanged." /SD IDCANCEL IDRETRY retryCleanup
    Pop $3
    Pop $2
    Pop $1
    Pop $0
    Abort
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend
!endif
