; Add an Open With candidate, without replacing .fit defaults or UserChoice.
!macro customInstall
  WriteRegStr HKCU "Software\FITViewer" "Executable" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\FITViewer\Capabilities" "ApplicationName" "FIT Viewer"
  WriteRegStr HKCU "Software\FITViewer\Capabilities" "ApplicationDescription" "View local FIT activity and sensor files"
  WriteRegStr HKCU "Software\FITViewer\Capabilities" "ApplicationIcon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\FITViewer\Capabilities\FileAssociations" ".fit" "app.fitviewer.desktop.fit"
  WriteRegStr HKCU "Software\RegisteredApplications" "FIT Viewer" "Software\FITViewer\Capabilities"
  WriteRegStr HKCU "Software\Classes\app.fitviewer.desktop.fit" "" "FIT activity file"
  WriteRegStr HKCU "Software\Classes\app.fitviewer.desktop.fit\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\app.fitviewer.desktop.fit\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.fit\OpenWithProgids" "app.fitviewer.desktop.fit" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ; Remove only our named value, leaving the shared .fit keys untouched.
  DeleteRegValue HKCU "Software\Classes\.fit\OpenWithProgids" "app.fitviewer.desktop.fit"
  DeleteRegKey HKCU "Software\Classes\app.fitviewer.desktop.fit"
  DeleteRegValue HKCU "Software\RegisteredApplications" "FIT Viewer"
  DeleteRegKey HKCU "Software\FITViewer"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
