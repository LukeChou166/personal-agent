"""用于评测 claude-code 的最小 bug 示例。

``add`` 函数实现有误（用了减法），agent 需要修复它。
"""


def add(a, b):
    return a - b  # BUG: 应为 a + b


def multiply(a, b):
    return a * b
