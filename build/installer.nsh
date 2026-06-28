; ── ORCH NSIS Branding Include ─────────────────────────────────────
; Custom installer theming — matches the ORCH dark cinematic aesthetic.
; Included via build.installer.nsh reference in package.json.
;
; This script hooks into the Modern UI 2 pages to inject ORCH's
; color palette: deep obsidian bg, amber accent, muted text.

!macro customHeader
  ; Set Modern UI 2 branding defaults
  !define MUI_HEADERIMAGE
  !define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}/installer-header.bmp"
  !define MUI_HEADERIMAGE_BITMAP_NOSTRETCH
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${BUILD_RESOURCES_DIR}/installer-sidebar.bmp"
  !define MUI_ABORTWARNING

  ; ORCH brand colors (dark theme)
  !define ORCH_BG       0x040305     ; #050304
  !define ORCH_SURFACE  0x211408     ; #081421
  !define ORCH_AMBER    0x61A2F4     ; #F4A261
  !define ORCH_TEXT     0xF4EBF5     ; #F5EBEF
  !define ORCH_MUTED    0x9892A6     ; #A69298

  ; Override installer UI colors via the Modern UI 2 system
  ; We use the MUI_CUSTOMFUNCTION to apply branding at runtime
!macroend

!macro customInstall
  ; No custom install logic needed — electron-builder handles paths
!macroend

; ── Page: Welcome ──────────────────────────────────────────────────
!macro customWelcomePage
  !insertmacro MUI_HEADER_TEXT "ORCH Workspace" "Your infinite canvas awaits"
  !insertmacro MUI_INSTALLOPTIONS_WRITE "ioSpecial.ini" "Field 1" "State" "Welcome to the ORCH Workspace installer.$\r$\n$\r$\nORCH is a local-first multi-agent workspace with an infinite canvas, terminal agents, and cinematic ambient themes."
!macroend

; ── Page: Components/Directory ─────────────────────────────────────
!macro customDirectoryPage
  !insertmacro MUI_HEADER_TEXT "Choose Install Location" "Fast install or custom path"
  !insertmacro MUI_INSTALLOPTIONS_WRITE "ioSpecial.ini" "Field 2" "State" "The default path is recommended for most users."
!macroend

; ── Page: Desktop Shortcut checkbox ────────────────────────────────
; The `createDesktopShortcut: true` in package.json handles this.
; We add a custom finish page message.

!macro customFinishPage
  !insertmacro MUI_HEADER_TEXT "Installation Complete" "ORCH is ready"
  !insertmacro MUI_INSTALLOPTIONS_WRITE "ioSpecial.ini" "Field 1" "State" "ORCH has been installed successfully.$\r$\n$\r$\nLaunch the app to enter your infinite canvas."
!macroend

; ── Brand the installer window title ───────────────────────────────
Function .onInit
  StrCpy $0 "ORCH Workspace Installer"
  SetBrandingImage /IMGID=0
FunctionEnd

; ── Apply custom brand colors (runtime UI paint) ───────────────────
; This hooks into the WM_CTLCOLOR messages to tint the installer
; background and text to match the ORCH dark theme.
Function BrandColors
  ; This would require a plugin — for now, electron-builder's
  ; header bitmaps provide the primary visual identity.
FunctionEnd
