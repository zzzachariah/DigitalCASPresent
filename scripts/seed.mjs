// Seed the local store with sample TOK Exhibition students so the app is
// demoable immediately (no admin work, no keys). Run: npm run seed
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

function avatarSvg(initials, c1, c2) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="400" height="400" fill="url(#g)"/>
  <circle cx="200" cy="160" r="70" fill="rgba(255,255,255,0.92)"/>
  <rect x="96" y="248" width="208" height="150" rx="104" fill="rgba(255,255,255,0.92)"/>
  <text x="200" y="182" font-family="Inter,Arial,sans-serif" font-size="64" font-weight="700"
    fill="${c1}" text-anchor="middle">${initials}</text>
</svg>`;
}

const people = [
  {
    id: "demo-emma01",
    slug: "emma",
    name: "Emma Lin",
    subtitle: "TOK Exhibition · “Why do we seek knowledge?”",
    language: "auto",
    avatar: { initials: "EL", c1: "#3366ff", c2: "#7aa2ff" },
    script: `Introduction.
For my TOK Exhibition I chose the IA prompt "Why do we seek knowledge?" I wanted to explore the very different motivations behind why people pursue knowledge — sometimes for survival, sometimes for connection, and sometimes simply out of wonder. I chose three objects from my own life that each answer this question in a different way.

Object 1: My grandmother's recipe notebook.
My first object is my grandmother's handwritten recipe notebook. She never measured anything precisely — the knowledge lived in her hands. This shows that we seek knowledge to preserve identity and pass it between generations. The recipes are knowledge encoded not in numbers but in experience and memory, which raises the question of how reliable knowledge can be when it is never written down exactly.

Object 2: A weather app on my phone.
My second object is the weather app I check every morning. Here we seek knowledge for a practical, almost survival-driven reason: to make decisions and reduce uncertainty about the future. But it also shows how we increasingly trust knowledge produced by systems we don't understand. I take the forecast on faith, even though I could not explain how the model works.

Object 3: A telescope.
My third object is a small telescope my dad gave me. Looking at Saturn for the first time, I wasn't solving any problem — I was just amazed. This object represents knowledge sought purely out of curiosity and wonder, with no practical payoff. It suggests that the desire to know is sometimes an end in itself, part of what makes us human.

Conclusion.
Together these three objects show that "why we seek knowledge" has no single answer: we seek it to remember who we are, to act wisely in the world, and simply because we are curious. The most interesting cases are when these motives overlap.`,
    sections: [
      { title: "Introduction", hint: "Why this prompt", key: "Introduction" },
      { title: "Object 1 · Recipe notebook", hint: "Knowledge & identity", key: "Object 1" },
      { title: "Object 2 · Weather app", hint: "Knowledge & trust", key: "Object 2" },
      { title: "Object 3 · Telescope", hint: "Knowledge & wonder", key: "Object 3" },
      { title: "Conclusion", hint: "Tying it together", key: "Conclusion" },
    ],
  },
  {
    id: "demo-zhang01",
    slug: "zhangwei",
    name: "张伟 Zhang Wei",
    subtitle: "TOK 展览 · “知识的生产是否总是合作性的？”",
    language: "auto",
    avatar: { initials: "张", c1: "#2451e6", c2: "#90b4ff" },
    script: `引入。
我的 TOK 展览选择的 IA 题目是“知识的生产是否总是合作性的？”。我想探讨：我们常说知识是站在巨人的肩膀上，但个人的灵感与独立思考又扮演什么角色？我选了三件物品来回应这个问题。

物品一：一本小组讨论的笔记。
第一件物品是我们物理小组的讨论笔记。上面有四个人不同颜色的字迹。它说明很多知识确实是合作产生的——没有人能独自想清楚所有步骤，是互相质疑和补充才让答案成形。

物品二：牛顿《自然哲学的数学原理》的复印页。
第二件物品是牛顿著作的一页复印件。牛顿常被当作孤独天才的象征，但他也承认自己借鉴了开普勒和伽利略。这让我思考：即使看起来是个人成就，背后也有一张看不见的合作网络。

物品三：我自己的一篇日记。
第三件物品是我的一篇日记。里面记录了一个只属于我自己的、还没有和任何人分享的想法。它提醒我，知识生产的最初火花有时是高度个人化的，合作可能发生在之后，而不是一开始。

结论。
这三件物品让我认为：知识的生产大多数时候是合作性的，但并非“总是”。个人的直觉与反思，往往是合作得以展开的起点。`,
    sections: [
      { title: "引入 · Introduction", hint: "为什么选这个题目", key: "引入" },
      { title: "物品一 · 小组笔记", hint: "知识与合作", key: "物品一" },
      { title: "物品二 · 牛顿著作", hint: "孤独天才？", key: "物品二" },
      { title: "物品三 · 个人日记", hint: "个人的火花", key: "物品三" },
      { title: "结论 · Conclusion", hint: "总结观点", key: "结论" },
    ],
  },
];

function splitByKeys(script, sections) {
  // Carve the script into each section's verbatim content using the first
  // line / keyword of each part as an anchor.
  const result = [];
  for (let i = 0; i < sections.length; i++) {
    const startIdx = script.indexOf(sections[i].key);
    const endIdx =
      i + 1 < sections.length ? script.indexOf(sections[i + 1].key) : script.length;
    const content = script.slice(startIdx === -1 ? 0 : startIdx, endIdx === -1 ? undefined : endIdx).trim();
    result.push(content);
  }
  return result;
}

async function main() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const now = Date.now();
  const records = [];

  for (const p of people) {
    const contents = splitByKeys(p.script, p.sections);
    const sections = p.sections.map((s, i) => ({
      id: `${p.id}-s${i}`,
      title: s.title,
      hint: s.hint,
      content: contents[i],
    }));

    await fs.writeFile(
      path.join(UPLOAD_DIR, `${p.id}.svg`),
      avatarSvg(p.avatar.initials, p.avatar.c1, p.avatar.c2),
      "utf8"
    );

    records.push({
      id: p.id,
      slug: p.slug,
      name: p.name,
      subtitle: p.subtitle,
      photoUrl: `/api/photo/${p.id}`,
      script: p.script,
      sections,
      language: p.language,
      createdAt: now,
      updatedAt: now,
    });
  }

  await fs.writeFile(
    path.join(DATA_DIR, "people.json"),
    JSON.stringify(records, null, 2),
    "utf8"
  );
  console.log(`Seeded ${records.length} people → data/people.json`);
  console.log("Visitor pages: /p/emma  and  /p/zhangwei");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
