# Windows 程式碼簽章

目前的安裝檔沒有簽章。使用者下載後，Windows SmartScreen 會跳出「Windows 已保護您的電腦」，
要按「其他資訊 → 仍要執行」才裝得起來；公司電腦常常直接擋掉。

發佈流程（`.github/workflows/release.yml`）已經準備好簽章：**只要在 GitHub 設定好下面其中一種，
下一次打包就會自動簽**，不用改任何程式或設定檔。沒設定的話照舊產出未簽章的安裝檔，
Actions 的執行結果會留一則警告。

有設定簽章、但某個檔案沒簽成功時，打包會直接失敗 —— 不會默默發出一個未簽章的版本。

## 選項一：Azure Trusted Signing（建議）

微軟的雲端簽章服務，月費制（Basic 方案約 US$10／月），不用自己保管憑證檔。
申請時需要通過身分驗證（個人或公司），通常要幾天。

1. 在 Azure 建立 Trusted Signing Account 與 Certificate Profile（Public Trust）。
2. 建一個 App registration（服務主體），在 Trusted Signing Account 上授予
   「Trusted Signing Certificate Profile Signer」角色，並建立一組 client secret。
3. 到 GitHub repo → Settings → Secrets and variables → Actions：

   | 類型 | 名稱 | 內容 |
   |---|---|---|
   | Secret | `AZURE_TENANT_ID` | 目錄（租用戶）識別碼 |
   | Secret | `AZURE_CLIENT_ID` | App registration 的應用程式識別碼 |
   | Secret | `AZURE_CLIENT_SECRET` | 上面建立的 client secret |
   | Variable | `AZURE_SIGN_ENDPOINT` | 帳戶所在區域的端點，例如 `https://eus.codesigning.azure.net` |
   | Variable | `AZURE_SIGN_ACCOUNT` | Trusted Signing Account 名稱 |
   | Variable | `AZURE_SIGN_PROFILE` | Certificate Profile 名稱 |
   | Variable | `AZURE_SIGN_PUBLISHER` | 憑證上的發行者名稱（CN），要一字不差 |

七個都要設定才會啟用；少一個就當作沒設定。

## 選項二：自己的憑證檔（.pfx）

向 CA 買的 OV / EV 程式碼簽章憑證。注意：2023 年起新發的憑證多半要求私鑰放在硬體裝置
（USB token / HSM）裡，沒辦法匯出成 .pfx 給 CI 用。這種情況請改用選項一，
或使用 CA 提供的雲端簽章服務。

能匯出成 .pfx 的話：

| 類型 | 名稱 | 內容 |
|---|---|---|
| Secret | `WIN_CSC_LINK` | .pfx 檔的 base64（PowerShell：`[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))`） |
| Secret | `WIN_CSC_KEY_PASSWORD` | .pfx 的密碼 |

兩種都設定時，用 Azure Trusted Signing。

## 簽章之後的注意事項

- **SmartScreen 信譽要時間累積。** 剛開始簽的版本，SmartScreen 仍可能提示，
  下載量累積之後才會消失。
- **自動更新會開始驗證簽章。** 簽章版本會記下發行者名稱（Azure 用 `AZURE_SIGN_PUBLISHER`，
  憑證檔則取自憑證本身），之後的更新如果不是同一個發行者簽的，electron-updater 會拒絕安裝。所以一旦開始簽，
  之後每一版都要簽；換憑證時發行者名稱要保持一致。
  還沒簽章的舊版本不做這項驗證，可以正常更新到第一個簽章版本。
