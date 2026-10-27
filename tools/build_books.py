# 从古腾堡原文生成插件内置的公版书节选（books/*.txt + books/index.json）
# 用法: python tools/build_books.py <古腾堡txt所在目录>
import json, os, re, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '../st-ref/books'
OUT = os.path.join(os.path.dirname(__file__), '..', 'books')
TARGET = 110_000  # 每本节选字符数

BOOKS = [
    ('pg2650.txt', 'proust_swann_fr', 'Du côté de chez Swann — Marcel Proust', 'fr'),
    ('pg7178.txt', 'proust_swann_en', "Swann's Way — Proust / Scott Moncrieff", 'en'),
    ('pg4300.txt', 'joyce_ulysses', 'Ulysses — James Joyce', 'en'),
    ('pg2600.txt', 'tolstoy_war_peace', 'War and Peace — Tolstoy / Maude', 'en'),
    ('pg24264.txt', 'honglou', '紅樓夢 — 曹雪芹', 'zh'),
    ('pg23962.txt', 'xiyou', '西遊記 — 吳承恩', 'zh'),
    ('pg25328.txt', 'doupeng', '豆棚閒話 — 艾衲居士', 'zh'),
]


def strip_gutenberg(t):
    s = re.search(r'\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n', t)
    e = re.search(r'\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG', t)
    return t[s.end() if s else 0:e.start() if e else len(t)]


def paragraphs(t, lang):
    t = t.replace('\r\n', '\n')
    paras = re.split(r'\n\s*\n', t)
    out = []
    for p in paras:
        if lang == 'zh':
            p = re.sub(r'\s+', '', p)
        else:
            p = re.sub(r'\s+', ' ', p).strip()
        # 只要像正文的段落，跳过标题、目录、版权行
        if len(p) < (40 if lang == 'zh' else 200):
            continue
        if re.search(r'gutenberg|http|www\.', p, re.I):
            continue
        out.append(p)
    return out


index = []
for fn, key, title, lang in BOOKS:
    raw = open(os.path.join(SRC, fn), encoding='utf-8', errors='replace').read()
    ps = paragraphs(strip_gutenberg(raw), lang)
    # 从全书 1/4 处开始取，避开开头的前言和目录
    start = len(ps) // 4
    picked, size = [], 0
    for p in ps[start:]:
        picked.append(p)
        size += len(p)
        if size >= TARGET:
            break
    with open(os.path.join(OUT, key + '.txt'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n\n'.join(picked))
    index.append({'id': key, 'title': title, 'lang': lang, 'file': key + '.txt', 'chars': size})
    print(key, len(picked), size)

with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump(index, f, ensure_ascii=False, indent=2)
