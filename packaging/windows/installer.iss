; Inno Setup script for CrateScan — per-user install, no admin/UAC required
; (PrivilegesRequired=lowest), same "one instance per user" spirit already
; used for cookies/data. Build with: iscc packaging/windows/installer.iss
;
; Prerequisite: run `node packaging/windows/build.mjs` first, so
; dist/CrateScan.exe and dist/bin/*.exe already exist — this script only
; packages what build.mjs already produced, it doesn't build anything itself.

#define MyAppName "CrateScan"
#define MyAppVersion "1.0.0"
#define MyAppExeName "CrateScan.exe"

[Setup]
; Regenerate this GUID (Tools > Generate GUID in the Inno Setup IDE) before
; a real release — this placeholder is only here so the script is valid.
AppId={{B4E7A2E1-2F3A-4B7E-9C2D-1A2B3C4D5E6F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=CrateScanSetup
Compression=lzma2
SolidCompression=yes

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\bin\*"; DestDir: "{app}\bin"; Flags: ignoreversion recursesubdirs

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na área de trabalho"; GroupDescription: "Atalhos adicionais:"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Abrir {#MyAppName} agora"; Flags: nowait postinstall skipifsilent
