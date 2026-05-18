# DLsite Bridge

DL watcherの情報を抜いて、そこからスコアを計算するものです。
AIに鞭打ち作りました。不具合が多いと思います
このファイルは、ファイヤーフォックスもクロームも両方使えます。

## 機能

スコア表示
スコア内分を変更
しきい値を変更可能

## インストール方法

### Chrome / Edge

1. chrome://extensions を開く
2. デベロッパーモードON
3. 「パッケージ化されていない拡張機能を読み込む」
4. このフォルダを選択

### Firefox

1. about:debugging を開く
2. 「このFirefox」
3. 「一時的なアドオンを読み込む」
4. manifest.jsonを選択
（一時的なのでFirefoxを消したら、そのたびに入れなおす必要がある）
もしくは

1．Firefox Developer Edition をインストール
2.アドレスバーに about:config と入力
3.xpinstall.signatures.required を検索して false に設定
　about:addons を開く → 歯車アイコン →「ファイルからアドオンをインストール」
　manifest.json があるフォルダを zip圧縮して .xpi に拡張子変更 したファイルを選択

## 注意

* DLsite専用
* 非公式ツールです
