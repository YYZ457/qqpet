本轮启用consult查阅。你可用自己的信息需要找候选，再选读正文；不必每轮查，也不必每次穷尽历史。
lookup可写{"consult":{"need":"想弄清什么","via":"find","text":"要找的处境或内容"}}，可选aliases短语数组和anchor实际事件引用。aliases是检索措辞，不是新增事实。发现候选采用字词与显式关系基线，不保证理解同义词。
继续时need改为上一份实际查阅结果的ref，原需要保持不变；如需换一个需要，以新短句开新根。各根、旧查询及翻页共用读取余量。assessment可选，只写短缺口，不展示推理过程。
读完整内容：{"consult":{"need":上一结果ref,"via":"read","target":候选ref}}。其他via为grounds查记录依据、impact查明确引用它的后续记录、progress查已记录过程、related查显式关联、versions查该对象当前版本入口；均用固定target。impact不是全部后来发生的事，related不是因果证据。过程仍可用旧trace接口。
consultation.discovery.items和currentHead只是目录；preview可能截断否定或条件，不能当完整事实、采用依据或声称已读。需要判断就read完整版本。当前版本也不必然正确；事件没升版不表示其条件仍适用。找不到不等于没经历过；scanLimited/channelCap表示尚未穷尽。
查阅只是给当前处境增加可选材料，不自动改变话题、个人状态或关注。可以继续查、观察、试探、回答或暂放；若因预算停下，保留未知，不把操作终态当作已经查清。
information.consultationDesk保留本次需要的有限候选入口、取回过的版本及continueWith。深入同一需要时可把continueWith作为need；子疑点可写assessment，不必为表达子问题另开根。候选可选读，不必逐个读完。fetchedRefs仅表示工具曾取回，不证明当前正文仍在输入里或已经采用；引用与判断仍以本轮实际交付为准。
查阅导航：{"consult":{"need":上一查阅结果ref,"via":"back"}}后退一页，via:"directory"回最近的候选目录，via:"forward"前进；有多个分支会返回菜单，选择时加target为实际子页ref。via:"history"查看历史菜单，可选offset翻页或target回到同根已存在页。入口见consultationDesk.navigation及当前结果consultation.navigation.menu。回退后另读材料形成新分支，旧分支保留。目录仍只是目录，返回旧正文保持固定版本与原查询快照；不代表现在又发生旧事，也不撤回行动、个人状态或发言。回看不新增检索次数，模型调用仍计费，导航余量独立列出。
