# テラウオークβ Firebase 設定

## 1. Firebase プロジェクトを作る

Firebase Console でプロジェクトを作成し、Web アプリを追加します。

https://console.firebase.google.com/

## 2. Firestore Database を作る

Firebase Console の「Firestore Database」からデータベースを作成します。
まず知り合いに試してもらうだけなら、テストモードで開始できます。

## 3. 設定を貼り付ける

Firebase Console に表示される `firebaseConfig` の値を `firebase-config.js` に貼り付けます。

```js
window.terawalkFirebaseConfig = {
  apiKey: "ここに貼り付け",
  authDomain: "ここに貼り付け",
  projectId: "ここに貼り付け",
  storageBucket: "ここに貼り付け",
  messagingSenderId: "ここに貼り付け",
  appId: "ここに貼り付け"
};
```

設定が空の間は、今まで通りブラウザ内のローカル保存で動きます。
設定を入れると、`templeRecords` コレクションに記録が保存されます。

## 4. 公開する

Firebase Hosting、GitHub Pages、Netlify などに、このフォルダの中身をアップロードします。
Firebase Hosting を使う場合は、あとで `firebase init hosting` と `firebase deploy` を実行します。

## 注意

テストモードの Firestore ルールは公開アプリには向きません。
本公開する場合は、Firebase Authentication と Firestore Security Rules を設定してください。
