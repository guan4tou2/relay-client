# 分流規則 — 設定檔格式參考

> **本文件是設定檔格式參考。** 一般使用直接在「分流」分頁操作即可——規則表、條件編輯、
> 模式切換、規則庫下載與規則模擬器都已有完整圖形介面（依 Claude Design v8 實作）。
> 這裡說明底層格式，給想直接編 `config.json`、或想了解引擎怎麼產生 sing-box 設定的人。

## 一條規則長什麼樣

一條規則回答兩個問題：**什麼情況**（`when`）→ **走哪裡**（`target`）。

```jsonc
{
  "id": "r1",
  "name": "Chrome 看 Netflix 走日本",
  "on": true,
  "target": "r-jp",              // "direct" | "block" | 某條路由的 id
  "when": {                      // 以下四個條件都可省略；有幾個就要「同時成立」幾個（AND）
    "app":     { "match": "name", "value": "chrome.exe" },
    "dest":    { "match": "suffix", "value": "netflix.com" },
    "port":    "443, 8000-9000",
    "network": "tcp"
  }
}
```

規則放在 `settings.split.rules`，**由上往下比對，第一條命中的就贏**，後面不再看。
都沒命中就走 `settings.split.defaultTarget`。

## 模式：規則 / 全域 / 直連

`settings.split.mode` 有三個值，對應 Clash 的三種模式。三者都在虛擬網卡（TUN）已建立的前提下切換——
**不需要重新提權**，切換約 1 秒；把引擎整個關掉才會拆掉 TUN、下次啟動要再過一次 UAC。

| `mode` | 行為 | `final` |
|---|---|---|
| `rule`（預設） | 照規則表比對，沒命中走 `defaultTarget` | `defaultTarget` |
| `global` | **規則表整個不參與**，所有流量走 `globalTarget` 指定的路由 | `globalTarget` |
| `direct` | 所有流量直連。TUN 仍在，斷線保護仍有效 | `direct` |

```jsonc
"split": { "mode": "global", "globalTarget": "r-jp", ... }
```

`global` 沒指定 `globalTarget`（或指到已刪除的路由）會安全退回直連，不會產生無效的 outbound。

三種模式都保留下面兩條內建規則。

## 內建保護規則

引擎永遠會在使用者規則**之前**插入兩條規則，順序固定：

1. **自我 bypass**（不可關閉）：app 自己與 `sing-box` 一律直連。否則「本地中繼 → 上游代理」的連線會被 TUN 再抓一次，造成無限迴圈。
2. **本機與內網 → 直連**（`settings.split.lanDirect`，預設 `true`，可停用但刪不掉）

### 為什麼需要第 2 條

TUN 的 `auto_route` 會注入預設路由，**內網流量一樣會進虛擬網卡**。只要 `defaultTarget` 指向代理路由
（很常見，例如「台灣直連、其餘走代理」這種設定），印表機、NAS、路由器管理頁、mDNS 就會被送進 SOCKS 代理然後失敗。
Proxifier 與 ProxyBridge 都內建同樣的保護——Proxifier 的 `Localhost` 規則就排在規則清單第一條。

涵蓋範圍（寫死的 CIDR，不需要下載 `geoip-private` 規則庫，離線可用）：

```
127.0.0.0/8        loopback
10.0.0.0/8  172.16.0.0/12  192.168.0.0/16   RFC1918 內網
169.254.0.0/16     link-local
100.64.0.0/10      CGNAT
224.0.0.0/4        multicast（含 mDNS / SSDP）
255.255.255.255/32 broadcast
::1/128  fc00::/7  fe80::/10                IPv6 loopback / ULA / link-local
```

**它排在使用者規則之前**，所以任何較寬鬆的規則（例如「Chrome → 代理」）都不會把內網流量搶走。
真的需要讓某個內網位址走代理時，把 `lanDirect` 設成 `false`，然後自己寫規則。

斷線保護（fail-closed）啟動時這條規則同樣保留——否則全域模式的 catch-all 會把使用者的內網一起切斷。

## config.json 位置

```
C:\Users\<你的帳號>\AppData\Roaming\RelayClient\config.json
```

> ⚠️ 編輯前請先**關閉 app**，否則存檔可能被執行中的 app 覆寫。改完存檔 → 重新開 app。

## 條件一覽

### `when.app` — 誰在連

| `match` | `value` | 說明 |
|---|---|---|
| `name` | `chrome.exe` | 程式名稱。Windows / macOS 不分大小寫，Linux 分 |
| `path` | `C:\Program Files\...\chrome.exe` | 完整路徑，可避免同名程式誤命中 |

### `when.dest` — 連去哪

| `match` | `value` 例子 | 說明 |
|---|---|---|
| `domain` | `example.com` | 網域完全相符 |
| `suffix` | `google.com`、`=login.example.com` | **預設含所有子網域**；開頭加 `=` 表示只要完全相符那一個網域。同一條可混寫（兩者是 OR） |
| `keyword` | `doubleclick` | 網域含這段文字。最寬鬆，容易誤傷 |
| `regex` | `^ad\\d+\\.example\\.com$` | RE2 語法。寫錯只會不命中，不會讓引擎壞掉 |
| `ip` | `10.0.0.0/8`、`8.8.8.8` | 沒寫遮罩會自動補 `/32`（IPv6 補 `/128`） |
| `ruleset` | `geoip-tw` | 規則庫：地區（GeoIP）或網站分類（GeoSite） |

### `when.port` / `when.network`

- `port`：`443`、`443, 8443`、`8000-9000`（範圍冒號或破折號都可以，會自動轉成引擎要的格式）
- `network`：`tcp` 或 `udp`。省略 = 兩者都算

### 值的寫法

所有 `value` 都接受**換行、逗號或分號分隔的多值**，或直接給字串陣列。前後空白與重複值會自動清掉：

```jsonc
"value": "netflix.com\nhulu.com, disneyplus.com"
"value": ["netflix.com", "hulu.com"]
```

### 會被略過的規則

- `when` 完全空的規則（想要「全部」請用 `defaultTarget`，不要寫空規則）
- 所有條件的值都是空字串
- `dest.match: "ruleset"` 但**規則庫還沒下載** — 整條規則略過。
  這是刻意的：只保留其他條件會讓規則從「Chrome 連台灣 IP」放寬成「Chrome 的所有流量」，
  而引用不存在的 rule-set 會讓 sing-box 直接 FATAL。

## 規則庫（rule-set）

sing-box 1.12 起已移除舊的 geoip/geosite 資料庫，地區與分類改用 **rule-set 檔**（`.srs` 二進位，或 `.json` 原始碼），放在：

```
C:\Users\<你的帳號>\AppData\Roaming\RelayClient\rulesets\
├── index.json          ← 中繼資料（代號、大小、sha256、更新時間、來源）
├── geoip-tw.srs
└── geosite-cn.srs
```

### 內建目錄

| 類別 | 代號 |
|---|---|
| 地區（GeoIP） | `geoip-tw` `geoip-cn` `geoip-jp` `geoip-hk` `geoip-kr` `geoip-sg` `geoip-us` `geoip-private` |
| 網站分類（GeoSite） | `geosite-cn` `geosite-geolocation-!cn` `geosite-google` `geosite-github` `geosite-openai` `geosite-netflix` `geosite-youtube` `geosite-telegram` `geosite-twitter` `geosite-apple` `geosite-microsoft` `geosite-steam` `geosite-category-ads-all` |

來源是 SagerNet 官方的 [sing-geoip](https://github.com/SagerNet/sing-geoip) 與 [sing-geosite](https://github.com/SagerNet/sing-geosite) rule-set 分支。

### 取得規則庫的三種方式

1. **由 app 下載**（未來的「規則庫」分頁；目前可在 DevTools 呼叫 `window.api.rulesetInstall('geoip-tw')`）。
   下載來源網域寫死成白名單，不吃任意網址。
2. **手動放檔**：把 `.srs` 放進 `rulesets\`，並在 `index.json` 補一筆：
   ```json
   [{ "tag": "geoip-tw", "kind": "geoip", "label": "台灣 IP", "url": "",
      "file": "geoip-tw.srs", "bytes": 184320, "sha256": "", "updatedAt": 0, "source": "import" }]
   ```
3. **自己編**：寫一份來源 JSON 再用引擎編譯 —— `engine\sing-box.exe rule-set compile --output my.srs my.json`

「分流 → 規則庫」子分頁可以管理已安裝的規則庫（更新、移除、匯入 .srs / .json、全部更新），
下半部是內建目錄可直接下載。規則編輯面板選「地區 · 分類」時，清單會分成「已下載」與「目錄中」兩組；
選了還沒下載的項目，儲存規則後會自動開始下載。規則列左緣的琥珀色標記代表「引用的規則庫還沒下載，這條規則目前不生效」。

自動更新與下載出口在「設定 → 規則庫」。

### 自動更新

預設**關閉**（關閉時本程式完全不連外）。要開啟，改 `settings`：

| 設定 | 預設 | 說明 |
|---|---|---|
| `rulesetAutoUpdate` | `false` | 開啟後啟動時會檢查並更新已安裝的規則庫 |
| `rulesetUpdateDays` | `7` | 兩次檢查最少間隔幾天 |
| `rulesetDetourRouteId` | `null` | 指定某條路由的 `id` → 規則庫改經由那條路由（含串鏈）下載 |

## 斷線保護在各模式下擋什麼

| `mode` | 引擎異常中止時 |
|---|---|
| `rule` | 只擋原本 `target` 不是 `direct` 的規則；原本直連的照常 |
| `global` | 本來全部走代理 → 一條 catch-all 全擋（內網與 app 自己除外） |
| `direct` | 本來就沒有流量走代理 → 沒有東西需要擋 |

## 完整範例

「內網與台灣直連、擋廣告、Chrome 看串流走日本、其餘走美國」：

```jsonc
"settings": {
  "routes": [
    { "id": "r-jp", "label": "日本節點", "localPort": 10812, "kind": "socks5", "hops": ["srv-jp"], "enabled": true },
    { "id": "r-us", "label": "美國節點", "localPort": 10813, "kind": "socks5", "hops": ["srv-us"], "enabled": true }
  ],
  "split": {
    "schema": 2,
    "defaultTarget": "r-us",
    "udp": false,
    "rules": [
      // 內網不用自己寫——內建的「本機與內網 → 直連」已經擋在所有規則之前
      { "id": "n2", "name": "台灣直連", "on": true, "target": "direct",
        "when": { "dest": { "match": "ruleset", "value": "geoip-tw" } } },
      { "id": "n3", "name": "擋廣告", "on": true, "target": "block",
        "when": { "dest": { "match": "ruleset", "value": "geosite-category-ads-all" } } },
      { "id": "n4", "name": "Chrome 看串流走日本", "on": true, "target": "r-jp",
        "when": { "app":  { "match": "name", "value": "chrome.exe" },
                  "dest": { "match": "suffix", "value": "netflix.com\ndisneyplus.com" },
                  "network": "tcp" } },
      { "id": "n5", "name": "擋 QUIC（讓瀏覽器退回 TCP，網域規則才嗅探得到）", "on": true, "target": "block",
        "when": { "port": "443", "network": "udp" } }
    ]
  }
}
```

順序很重要：`n2` 在 `n4` 之前，台灣的流量才不會被後面的規則搶走。

## 驗證

規則模擬器用**和引擎完全相同的順序與 AND 語意**比對，包含真的去查規則庫：

```js
// DevTools（Ctrl+Shift+I）
await window.api.ruleMatch({ host: 'www.netflix.com', exe: 'chrome.exe', port: 443, network: 'tcp' })
// → { matched: true, by: 'composite', ruleId: 'n4', ruleName: 'Chrome 看串流走日本',
//     target: 'r-jp', targetLabel: '日本節點',
//     detail: 'process_name=chrome.exe AND domain_suffix=netflix.com|disneyplus.com AND network=tcp' }
```

`by` 會告訴你命中的是哪種規則：`app`（只有程式條件）、`net`（只有目的地）、`composite`（混用）、`default`（沒命中）。

也可以直接問引擎某個值在不在規則庫裡：

```bash
engine\sing-box.exe rule-set match "%APPDATA%\RelayClient\rulesets\geoip-tw.srs" -f binary 1.34.1.1
```

規則寫壞的話，看「紀錄」分頁的 `engine` 來源；設定不合法時引擎不會啟動，錯誤訊息會原樣顯示。

## 從舊版升級

v1.1.x 的兩張分開的表（`rules` 依程式 / `netRules` 依網域）會在第一次讀取時**自動合併成一張**：

- 每條舊規則變成只有單一條件的新規則，走向、停用狀態、名稱都保留
- 合併順序照舊的 `ruleOrder`（預設 `app-first` = 程式規則排在前面）
- 合併後 `netRules` 與 `ruleOrder` 欄位會被移除，`schema` 標成 `2`
- 遷移只做一次，且會立刻寫回設定檔

不需要手動處理，也不會遺失資料。

## 已知限制

- **網域條件需要嗅探**：虛擬網卡只看得到目的地 IP，要靠嗅探 TLS SNI / HTTP Host 才拿得到網域。
  引擎**只有在存在網域條件時**才開啟嗅探；純 IP／地區／埠／協定條件不受影響。
  代價是：加密 ClientHello（ECH）或非 TLS/HTTP 的自訂協定可能嗅不到網域。
- **UDP / QUIC**：能不能走代理取決於上游支不支援 UDP（HTTP CONNECT 與 SOCKS4 只有 TCP）。
  瀏覽器的 QUIC 會繞過網域規則——需要精準分流時，加一條 `{ port: "443", network: "udp" } → block`
  逼瀏覽器退回 TCP（範例裡的 `n5`）。
- **地區資料會過期**：GeoIP 資料每隔一段時間就該更新，否則地區判斷會不準。
- **`keyword` 很寬鬆**：`google` 會連 `notgoogle.com` 也一起中，建議優先用 `suffix`。
- **斷線保護**：引擎異常中止時，所有 `target` 不是 `direct` 的規則會一起被封鎖（fail-closed），
  包含複合規則；只有原本就直連的規則不受影響。
