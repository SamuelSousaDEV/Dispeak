; Included by electron-builder in the installer (package.json, nsis.include).

!macro customUnInstall
  ; An update runs the old uninstaller too: only a real uninstall forgets the start at login.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Dispeaker"
  ${endIf}
!macroend
