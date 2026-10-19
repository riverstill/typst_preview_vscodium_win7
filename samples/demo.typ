#set page(width: 14cm, height: auto, margin: 1.2cm)
#set text(font: ("Segoe UI", "Microsoft YaHei"), size: 10pt)

= Typst 实时预览测试

这是一个用来测试插件实时预览功能的示例文档。修改这一行文字，右侧预览应当在大约 300ms 后自动刷新。

== 数学公式

$ integral_0^1 x^2 dif x = 1/3 $

== 列表与代码

- 第一项
- 第二项
+ 有序一号
+ 有序二号

```typ
#let f(x) = x * 2
#f(21)
```

== 表格

#table(
  columns: (1fr, 1fr, 1fr),
  [名称], [数量], [备注],
  [苹果], [3], [红色],
  [香蕉], [5], [黄色],
)

#pagebreak()

第二页：用于验证多页渲染与滚动位置保持。
