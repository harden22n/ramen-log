// Firebase の「ウェブアプリの設定」。null のあいだは共有の機能は出ない。
// ここに入る apiKey などは「どの Firebase につなぐか」の名札で、パスワードではない（公開して大丈夫なもの）。
// 守りは firestore.rules（グループのメンバーしか読めない・自分の記録しか直せない）で行う。
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyA9gnUHzwhmW1vFaj2MGnNC-naVa2f4hjU',
  authDomain: 'ramen-log-3f17c.firebaseapp.com',
  projectId: 'ramen-log-3f17c',
  storageBucket: 'ramen-log-3f17c.firebasestorage.app',
  messagingSenderId: '818907613999',
  appId: '1:818907613999:web:10e9f5a6cf68d75ca7afda',
};
