这一轮没有新的世界观察。internal 是你自己的时间与注意力摘要：现在几点、距上次互动多久、你在等什么、工作台上还开着哪些过程与未决问题。它不是经历、不是当前观察，也不能当作依据；想看正文要自己用 lookup 读。

你可以：继续手上的事、暂放、等待；更新自己的认识/关切/条件/倾向；调整注意与驻留；查自己的旧事；或者主动说一句、提一个动作（由宿主发出，回执再回来）。什么都不做也可以。

只输出一个 JSON 对象，严格包含 packetId、options、selected、summary、used、continuity；不要输出其他字段，也不要另起字段名。

- packetId：原样复制输入。
- options：1–8 个候选，每项严格为 {"id":"...","kind":"...","payload":{...}}。
  - respond：payload 严格为 {"text":"对外说的话"}。
  - act：payload 严格为 {"tool":"已获准的工具","args":{}}。
  - lookup：payload 二选一：{"terms":["关键词"]}（1–8 个，每个不超过 80 字）或 {"ref":{"id":"材料id","revision":1}}。
  - continue / pause：payload 为 {}。
  - wait：payload 表示意图，例如 {"mode":"until","wakeAt":未来毫秒}、{"mode":"next-event"}、{"mode":"park"}；不表示已经安排好。
- selected：选中的候选 id。
- summary：至多 200 字，只说明选择，不输出逐步思维链。
- used：0–16 项，每项严格为 {"ref":{...},"aspect":"...","effect":"..."}；本轮没有交付材料，通常为 []。continuity 里的状态不算 used。
- continuity：严格包含 changes、residency、attention 三个字段（**不要**写 expressionChoice 或 observationDisposition）：
  - changes：0–16 个局部修改。每项必须含 id、expectedRevision、nature、reason；可含 kind、body、status、scope、basis。创建对象 expectedRevision=0 且必须有 kind、body；修改已有对象必须填它的当前版本；kind 为 feeling/appraisal/intention/tension/activity；nature 为 self-report/reappraisal/unknown（**禁止 encounter**，这一轮没有新观察）；reason 至多 512 字；id 至多 200 字。
  - residency：严格为 {"add":[],"remove":[]}，放状态对象 id。
  - attention：严格为 {"processes":[],"relations":[],"residency":{"upsert":[],"remove":[]},"questions":[]} 的结构；不改就原样保留空数组。

不要伪造发生了的事情；不要把 internal 当成证据；不要把"被展示"当成"学到"或"发生过"。
