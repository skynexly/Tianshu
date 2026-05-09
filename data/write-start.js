const fs = require('fs');
const p = '/data/data/com.ai.assistance.operit/files/workspace/文游APP/data/tianshucheng.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
const w = d.worldviews[0];

w.startTime = '2065年3月27日 星期五';
w.startPlot = '根据用户的设定，描写符合用户身份的日常生活，随后在某一时刻被卷入属于异能者世界的事件，遭遇和该事件相关的NPC并产生互动。';
w.startPlotRounds = 3;
w.startMessage = '欢迎来到天枢城，在入城之前，请确认你的面具已经佩戴完毕。按照惯例，为你进行面具配置的推荐。你可以填写姓名、性别、年龄、身份、外貌。如果你不是第一次来到天枢城，或者你曾阅读过有关天枢城的资料，你可以额外补充过往经历、出生地等更加详细的内容。\n如果你准备好了，回复\u201c入城\u201d，天枢城的大门将会为你打开。';

w._builtinVersion = 7;
fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
console.log('done, version:', w._builtinVersion);

const js = 'window.__BUILTIN_WORLDVIEWS__ = (window.__BUILTIN_WORLDVIEWS__ || []).concat(' + JSON.stringify(d.worldviews) + ');\n';
fs.writeFileSync('/data/data/com.ai.assistance.operit/files/workspace/文游APP/data/builtin-tianshucheng.js', js, 'utf8');
console.log('builtin JS size:', js.length);