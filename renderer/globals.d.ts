// preload.js 用 contextBridge 掛上來的橋接物件（見 preload.js）。
// 這裡只宣告「有這個東西」，各方法的回傳值以 any 看待；型別檢查的重點是畫面端自己的程式。
interface Window {
  api: any;
  __boot: Record<string, number>;
}
