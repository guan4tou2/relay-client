; 安裝前先請執行中的 RelayClient 自己好好結束。
;
; 為什麼不用 taskkill /F：強殺會跳過 app 的 before-quit 清理，
; 留下還沒移除的 TUN 虛擬網卡與已啟用的系統代理設定 —— 使用者裝完會發現上不了網。
; 帶 --quit 啟動一個新實例，它拿不到單一實例鎖，意圖會轉給執行中的那個，
; 由它走完整的 app.quit()（停引擎、移除 TUN、關系統代理）再退出。
!macro customInit
  ${If} ${FileExists} "$INSTDIR\RelayClient.exe"
    DetailPrint "請 RelayClient 結束並清理…"
    nsExec::Exec '"$INSTDIR\RelayClient.exe" --quit'
    Sleep 3000
  ${EndIf}
!macroend
