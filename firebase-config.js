// Firebase の「ウェブアプリの設定」。null のあいだは共有の機能は出ない。
// ここに入る apiKey などは「どの Firebase につなぐか」の名札で、パスワードではない（公開して大丈夫なもの）。
// 守りは firestore.rules（グループのメンバーしか読めない・自分の記録しか直せない）で行う。
export const FIREBASE_CONFIG = null;
