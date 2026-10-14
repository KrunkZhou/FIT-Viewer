; File-type registration is deferred until the user chooses it in the app.
!macro customInstall
  WriteRegStr HKCU "Software\FITViewer" "Executable" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend

!macro customUnInstall
  ; Remove only our named value, leaving the shared .fit keys untouched.
  DeleteRegValue HKCU "Software\Classes\.fit\OpenWithProgids" "app.fitviewer.desktop.fit"
  DeleteRegKey HKCU "Software\Classes\app.fitviewer.desktop.fit"
  DeleteRegValue HKCU "Software\RegisteredApplications" "FIT Viewer"
  DeleteRegKey HKCU "Software\FITViewer"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
