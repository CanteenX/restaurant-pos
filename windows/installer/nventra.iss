; Nventra POS Windows installer (Inno Setup 6). Build: build-installer.ps1
#define AppName "Nventra POS"
#define AppVersion GetEnv("NVENTRA_VERSION")
#if AppVersion == ""
  #define AppVersion "0.0.0-dev"
#endif

[Setup]
AppId={{6B1F2F0E-5C0A-4C55-9E55-4E6E7A1B0A88}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Nventra
DefaultDirName={autopf}\NventraPOS
DefaultGroupName={#AppName}
OutputDir=out
OutputBaseFilename=NventraPOS-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=admin
UninstallDisplayName={#AppName}
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern

[Files]
Source: "..\..\docker-compose.yml"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\.env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "setup-nventra.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\..\NOTICE"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
Name: "{group}\{#AppName}"; Filename: "http://localhost:1995"
Name: "{group}\Start services"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup-nventra.ps1"" -AppDir ""{app}"" -Action start"
Name: "{group}\Stop services"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup-nventra.ps1"" -AppDir ""{app}"" -Action stop"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "http://localhost:1995"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup-nventra.ps1"" -AppDir ""{app}"" -Action install"; StatusMsg: "Checking Docker/WSL2 and starting services..."; Flags: runhidden waituntilterminated; Check: not WizardSilent

[UninstallRun]
; Stops containers only; the database volume is kept so data survives a reinstall.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup-nventra.ps1"" -AppDir ""{app}"" -Action down"; Flags: runhidden; RunOnceId: "StopNventra"
