const { deflateSync } = require('zlib');

const aa = `
　　　　　　　　　　　　　 ／　,ｨ彡ニ三三ミヽ　＼
　　 　 　 　 　 　 　 　 / -‐／-三三ニ二彡ヽ　 ヽ
　　　 　 　 　 　 　 　 ﾉ 〃　ノ三ミヽ三三彡ハ　 ﾐ､
　　　　　　　　　　　 / j/　'"彡-―---イノj 　 ヽ　 |
　　　　　　　　 　 　 { /　ｆ　　　　　　　　　　　 　 }　}
　　　　　　　　　　　 |　川　　　　　　　　　　　　　ﾐj |､
　 　 　 　 　 　 　 　 }　〃　 　＿　　 　 　 ／＾ 　 ﾐ:j }
　　　　　　　　　　 　 Vjﾊ 　 '"￣ﾞヽヽ- ､/.,=≡､　 !リ
　　　　　　　　　　　　 ､ﾊﾐ　 ､=≡=､　⌒ ､--‐　　 ﾘ
　　　　　 　 　 　 　 　 ヽ彡　'⌒ー' ,.:　 　 ､._ 　 　 |
　　　　　　　　　　　 　 　 ヽ　　 　/ (_　　 ノ ヽ　　 |
　　　　　　　　　　　 　 　 /＾)　 　′,.ｨ｀ﾞ´ｪy　 }　 /
.　　 　 　 　 　 i＾ヽ　　　/　∧　 r　ﾞー─'''　 ノﾉ ハ
　　　　　　　　　',　'., 　/　./{（ ＼丶　￣￣　 ／/::|:::＼＿_
　 　 　 　 (＾＼　', 　Ｖ　　{:::＼､　｀ ｰ-　-‐'"／::::ﾉ:::::）ヽ:::::＼＿
　　　r――＼　ｰ'　　 　 　､::::ヽ＼　　　　／/:::::/::::::/　 }ﾉ:::::::::::::＼＿
　　 ﾉ::＼（:::::::::>　　　　　　　ー――-､　/／:::::/::::::/　 /::::::::::::ﾉ::::/:::::::＼
　／::::::::::＼:／ 　 　 　 }　　 　 ,...---‐' //::::::::/:::::::{ 　 {::::::::::/::／::::::::::::::::ヽ
/:::::::::::::::::(´＿,.ィ　　　/-―イ::::::::::i　 Ｖ/:::::::::/::::::::ﾉ　 ﾉ:::::／::::::::::::::::::::::::::::::i`;

const raw = Buffer.from(aa, 'utf-8');
const deflated = deflateSync(raw);

console.log('=== AA サイズ分析 ===');
console.log('文字数:          ' + aa.length + ' 文字');
console.log('UTF-8 バイト数:  ' + raw.length + ' bytes');
console.log('deflate 圧縮後:  ' + deflated.length + ' bytes (' + (deflated.length/raw.length*100).toFixed(1) + '%)');
console.log('');
console.log('パケットヘッダー: ~225 bytes');
console.log('合計サイズ:       ' + (deflated.length + 225) + ' bytes');
console.log('2KB上限:          2048 bytes');
console.log('収まる？:         ' + (deflated.length + 225 <= 2048 ? '✅ YES' : '❌ NO'));
