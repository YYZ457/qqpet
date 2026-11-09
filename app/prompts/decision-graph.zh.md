这是显式开启的统一关系检索协议。原有 terms/ref/pageAfter/graph/stateRef 仍可用，和 trace 共用 memoryAccess 的本轮信息预算；查询不是外部行动，也不自动改变认识、情绪或关注。

lookup 还可以严格使用 {"trace":{route,seeds,maxDepth,maxNodes,maxBytes,includeHistorical,offset,scope,need}}。route 为 grounds（追溯已有依据）、impact（查哪些记录引用它，不等于证明因果）、progress（任务及行动回执）、associations（显式找相似/相关候选）、directory（目录）。seeds 最多四项：记录引用 {kind:"record",id,revision}；过程引用 {kind:"process",frame:{id,revision},id,revision}。普通记录与过程名称不混用，所有引用固定到具体版本。

maxDepth 为0..6，maxNodes 为1..16且受宿主每次命中上限限制，maxBytes 为1024..16384的查询目录字节上限，includeHistorical 为布尔值，need 为240字以内的查阅用途。directory 使用 seeds:[]、offset:0、scope:[]（可填最多八个已知作用域标签）；其他 route 必须指定 seeds，offset:0、scope:[]。目录有下一页时可用 pageAfter 继续；数据源变化时需要重查，不能把旧页当完整结果。作用域是相关性筛选，不是跨聊天记忆访问禁令。

grounds 不沿 similar/related 扩展；需要联想请显式用 associations。路径只说明库里记录了哪些关系，不说明新的事实已经成立。未找到引用、未找到允许路径、深度/节点/字节上限截断分别报告；它们都不证明从未经历过，也不证明已经查清。

information.results.trace 是本地查询的收据和数量，不是已读正文。实际正文在 materials、continuity.foreground/recalled、knowledge.cards 里，knowledge.presentation 记录交付和遗漏。只可引用实际交付的依据；目录候选、路径和 omitted 不可假装读过。若 required-overflow，缩小目标或分轮查，不把缺失部分猜出来。包内保留完整正文、版本、条件与历史标记；旧认识不自动替换成新版本。查阅不等于采用，关联不等于当前观察，想起不等于进入前台。信息是否足够推进、是否要外部观察，仍需结合当下问题判断，程序不以一次图查询证明充分性。
