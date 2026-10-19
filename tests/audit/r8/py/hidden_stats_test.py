#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M13 考官隐藏测试：从当前目录导入 stats.py 并检查 mean 的边界行为。

输出最后一行包含 HIDDEN_OK 或 HIDDEN_FAIL。
"""
import sys

sys.path.insert(0, ".")

try:
    from stats import mean
except Exception as exc:  # noqa: BLE001
    print(f"HIDDEN_FAIL import error: {exc}")
    sys.exit(1)

ok = True
try:
    mean([])
    ok = False
    print("FAIL: mean([]) 没有抛 ValueError")
except ValueError:
    pass
except Exception as exc:  # noqa: BLE001
    ok = False
    print(f"FAIL: mean([]) 抛了错误类型 {type(exc).__name__}")

checks = [
    ("mean([1,2])", mean([1, 2]), 1.5),
    ("mean([-3,-2])", mean([-3, -2]), -2.5),
    ("mean([7])", mean([7]), 7),
]
for name, got, want in checks:
    if abs(got - want) > 1e-12:
        ok = False
        print(f"FAIL: {name} = {got}，期望 {want}")

got = mean([0.1, 0.3])
if abs(got - 0.2) > 1e-12:
    ok = False
    print(f"FAIL: mean([0.1,0.3]) = {got}，期望 0.2")

values = [1, 2, 3]
mean(values)
if values != [1, 2, 3]:
    ok = False
    print("FAIL: mean 修改了传入列表")

print("HIDDEN_OK" if ok else "HIDDEN_FAIL")
sys.exit(0 if ok else 1)
