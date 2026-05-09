const fs = require('fs');
const p = '/data/data/com.ai.assistance.operit/files/workspace/文游APP/data/tianshucheng.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
const w = d.worldviews[0];

w.startMessage = '欢迎来到天枢城，在入城之前，请确认你的面具已经佩戴完毕。按照惯例，为你进行面具配置的推荐。你可以填写姓名、性别、年龄、身份、外貌。如果你不是第一次来到天枢城，或者你曾阅读过有关天枢城的资料，你可以额外补充过往经历、出生地等更加详细的内容。\n如果你准备好了，回复"入城"，天枢城的大门将会为你打开。\n\n<!--这是新手引导消息，不是剧情开篇。请等待用户填写完面具信息并回复"入城"后，再根据开场剧情指令开始正式剧情。不要在此基础上续写剧情。-->';

w._builtinVersion = (w._builtinVersion || 8) + 1;
fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');

const js = 'window.__BUILTIN_WORLDVIEWS__=(window.__BUILTIN_WORLDVIEWS__||[]).concat(' + JSON.stringify(d.worldviews) + ');\n';
const jp = p.replace('tianshucheng.json', 'builtin-tianshucheng.js');
fs.writeFileSync(jp, js, 'utf8');

console.log('done, version:', w._builtinVersion);
console.log('builtin JS size:', js.length);