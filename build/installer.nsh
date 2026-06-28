; ── ORCH NSIS Branding Include ─────────────────────────────────────
; Custom installer theming — matches the ORCH dark cinematic aesthetic.
; Included via build.installer.nsh reference in package.json.
;
; This script hooks into electron-builder's Modern UI 2 template
; to inject ORCH's custom header bitmap and page text.

!macro customHeader
  ; ORCH custom header bitmap is set via installerHeader in package.json.
  ; This macro is called after MUI_HEADERIMAGE is defined.
!macroend

!macro customInstall
  ; No custom install logic needed — electron-builder handles paths
!macroend

; ── Override welcome page subtitle ────────────────────────────────
!macro customWelcomePage
  ; Electron-builder generates the welcome page —
  ; we keep the default behaviour with our custom sidebar bitmap.
!macroend
