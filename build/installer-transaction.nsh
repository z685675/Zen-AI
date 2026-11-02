!ifndef ZEN_INSTALL_TRANSACTION_INCLUDED
!define ZEN_INSTALL_TRANSACTION_INCLUDED
!ifndef BUILD_UNINSTALLER
; Callbacks compile before multiUser.nsh; use the identical registry key default.
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
Var ZenInstallTransactionActive
Var ZenInstallScope
!ifdef UNINSTALL_REGISTRY_KEY_2
  !define ZEN_LEGACY_UNINSTALL_ARG '-LegacyUninstallRegistryKey "${UNINSTALL_REGISTRY_KEY_2}"'
!else
  !define ZEN_LEGACY_UNINSTALL_ARG ''
!endif

!macro ZenRunInstallTransaction ACTION
  Push $0
  Push $1
  Push $2
  InitPluginsDir
  ; Release the install directory as the installer's working directory before
  ; renaming it, including recovery after a failed payload extraction.
  SetOutPath $PLUGINSDIR
  File /oname=$PLUGINSDIR\zen-install-transaction.ps1 "${BUILD_RESOURCES_DIR}\install-transaction.ps1"
  StrCpy $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${If} $ZenInstallScope == ""
    StrCpy $ZenInstallScope "CurrentUser"
  ${EndIf}
  nsExec::ExecToStack '"$2" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\zen-install-transaction.ps1" -Action ${ACTION} -InstallDirectory "$INSTDIR" -InstallMode "$ZenInstallScope" -Language $LANGUAGE -InstallRegistryKey "${INSTALL_REGISTRY_KEY}" -UninstallRegistryKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" ${ZEN_LEGACY_UNINSTALL_ARG}'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    ${If} $LANGUAGE == 2052
      MessageBox MB_ICONSTOP "安装未完成，程序文件的替换已停止。请根据下方提示处理后重试。$\r$\n$\r$\n$1" /SD IDOK
    ${ElseIf} $LANGUAGE == 1028
      MessageBox MB_ICONSTOP "安裝未完成，程式檔案的替換已停止。請依下方提示處理後重試。$\r$\n$\r$\n$1" /SD IDOK
    ${Else}
      MessageBox MB_ICONSTOP "Installation could not finish. File replacement has stopped. Resolve the issue below, then run Setup again.$\r$\n$\r$\n$1" /SD IDOK
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
    !if "${ACTION}" != "Rollback"
      Abort
    !endif
  ${Else}
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
  SetOutPath $INSTDIR
!macroend

!macro customPrepareInstall
  ; electron-builder's outer app-running check is skipped by the elevated
  ; instance. This hook runs for both modes after the final directory selection.
  ${If} ${UAC_IsInnerInstance}
    Call waitForUpdateParent
    Call closeRunningZenAI
  ${EndIf}
  StrCpy $ZenInstallScope "$installMode"
  StrCpy $ZenInstallTransactionActive "1"
  !insertmacro ZenRunInstallTransaction "Prepare"
!macroend

Function ZenRollbackInstallation
  ${If} $ZenInstallTransactionActive == "1"
    !insertmacro ZenRunInstallTransaction "Rollback"
    StrCpy $ZenInstallTransactionActive "0"
  ${EndIf}
FunctionEnd

Function .onInstFailed
  Call ZenRollbackInstallation
FunctionEnd

Function .onGUIEnd
  Call ZenRollbackInstallation
FunctionEnd
!endif
!endif
