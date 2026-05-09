#!/usr/bin/env python3
"""CSS 括号平衡检查 — 言殊的耻辱纪念碑"""
import re, sys

path = sys.argv[1] if len(sys.argv) > 1 else 'css/style.css'
with open(path) as f:
    raw = f.read()

# 去注释
clean = re.sub(r'/\*.*?\*/', '', raw, flags=re.DOTALL)
lines = clean.split('\n')

depth = 0
errors = []
for i, line in enumerate(lines, 1):
    for ch in line:
        if ch == '{': depth += 1
        elif ch == '}': depth -= 1
    if depth < 0:
        errors.append(f'  ✗ 第{i}行: 多余的 }} (depth={depth})')
        depth = 0  # reset继续扫

o = clean.count('{')
c = clean.count('}')

if o == c and not errors:
    print(f'✓ {path}: {o}开 {c}闭，完全平衡。')
else:
    print(f'✗ {path}: {o}开 {c}闭，差{abs(o-c)}个')
    for e in errors:
        print(e)
    sys.exit(1)
