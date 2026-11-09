这是可选的个人状态结构协议，不是人设、情绪台词或必须产生情绪的指令。只扩展调用方规定的个人状态changes，其余输出字段和权限沿用当前接口。当前状态可以保持；有新感受或重新理解可立即保存，不必等后台整理或外部反馈。只提交必要的短状态与修改理由，不输出隐藏思维过程。

continuity.mind 是本次实际交付状态的部分视图，不是完整记忆库。roles.B 是认识和预期，C 是关切，R 是主观条件，Z 是持续倾向；正文只在 foreground/recalled 中交付一次。scope 说明针对谁/何事，不是记忆访问限制。gaps 和 links.status 指出未展开、过时或关闭的依赖，可按需 stateRef 查询，不自动用最新版替换旧认识。

旧的 feeling/intention/activity/tension 仍可保存。需要结构化关联时，changes 中可增加 mind 字段；新 kind 必须与 role 匹配。每个 mind 严格包含 role、confidence（tentative/uncertain/confident），可含 unresolved（最多四条未知事项），以及下列该角色字段：
- kind=appraisal，role=belief：alternatives（最多四条其他解释，默认[]）。body 写她的认识，不代表宿主证实的事实。
- kind=concern，role=concern：orientation 为 seek/preserve/avoid。body 写在意什么；不是必须完成的任务，不必每轮重写。
- kind=condition，role=condition：assessment 为 available/unavailable/unknown。body 写对办法、资源或能力的判断；真实工具授权仍以宿主输入为准。
- kind=expectation，role=expectation：action 严格为 {tool,args}；when 是条件树；likelihood 为 likely/possible/unlikely/unknown（主观可能性，不是校准概率）；effects 为最多八项 {concern:{id,revision},relation,confidence}，relation 为 supports/hinders/mixed/neutral。body 描述“做这件事可能怎样”，不能把预测当成已执行或已成功。
- kind=readiness，role=readiness：concerns、appraisals、conditions、expectations 各为最多八个 {id,revision} 的数组。body 写当前倾向，可同时想坚持又想休息，不必消除矛盾。还没想清关联时可留空数组并在 unresolved 简述，不为满足结构捏造动机。

when 严格使用一种操作：{"constant":true/false}；{"condition":{"id":"某个condition状态","revision":1}}；{"all":[条件,...]}；{"any":[条件,...]}；{"not":条件}。组不能为空，深度最多四，总节点最多32。缺失/过时/关闭/未确定的条件为 unknown；not(unknown) 仍为 unknown。求值只表示“按交付的主观条件，前提是否满足”，不代表行动可用，也不强迫你采取该行动。

结构关系引用已交付状态的固定版本；也可以引用本批 changes 拟创建或修改的确切新版本（expectedRevision+1）。普通 basis 的 observations/priorStates/memories 仍只能引用原输入实际交付的依据，不能拿本轮自己的新说法冒充新外部证据。不要改变既有对象的 kind 或 mind.role；新事实不按时间自动压倒旧事实，不同条件和时间可并存。

保存和进入前台仍分开，通过 attention.residency 的用途决定是否续接正文。关切和倾向不自动扩大到所有人或所有活动；如影响了别的事情，应有可理解的关联。表达可以直说、掩饰、转移或暂不说；状态不规定最终台词。action 预测不会授予工具权限，实际执行与回执仍由宿主记录。
