# 云枢支付 PivotPay · 4 分钟项目介绍视频｜社交媒体文案包

> 配套成片：`video/云枢支付PivotPay_项目讲解_1080p.mp4`（1920×1080 / 25fps / 4:00 / 中英双语烧录字幕 + 外挂 SRT）
> 使用说明：以下文案可直接复制发布；`[ ]` 内为按平台自行替换项。所有平台请保留「合规口径」那一句。
> 仓库地址（所有平台统一）：https://github.com/clawgeek/pivotpay
> 统一口径：这是**沙箱演示系统**，不接真实资金、不提供支付服务；源码与文档已在上述公开仓库。

---

## 0. 一句话定位（所有平台复用）

**云枢支付 PivotPay**：用 DDD 把高可用云端支付平台从架构图变成能点、能测、能回放的代码。

核心事实（可自由组合，勿夸大）：

| 维度 | 事实 |
| --- | --- |
| 架构 | 四层 DDD、7 个限界上下文、共享内核 + 防腐层 |
| 领域 | `PaymentOrder` 聚合根显式状态机、退款不超实付、乱序/重复回调不可覆盖终态 |
| 高可用 | 加权健康度路由、三态熔断、最多 2 次自动 failover、8 类故障注入 |
| 一致性 | 订单 + 复式分录 + Outbox 同事务、Webhook 指数退避与死信、日终对账 |
| 安全 | HMAC-SHA256 + nonce 防重放、幂等键、租户隔离、审计 traceId |
| 界面 | React 19 + Meta 开源 Astryx 设计系统，10 页多租户 SaaS 控制台 |
| 演示 | 浏览器 Web Crypto 真实算签名下单 → 二维码 → 4 种回调演练 |
| 验证 | 43 项端到端冒烟测试全通过，前后端类型检查与生产构建零错误 |
| 依赖 | Node 22 内置 SQLite，零外部服务，单端口 3001 同时托管 UI 与 API |
| 源码 | https://github.com/clawgeek/pivotpay（README + 3 份设计文档 + 43 项测试脚本） |

---

## 1. B 站（主发布平台 · 科技/编程区）

### 标题（三选一）

1. `4 分钟讲透一套 DDD 高可用支付平台：从聚合根到熔断 failover`
2. `NestJS + React 19 做 SaaS 支付平台：43 项测试全绿，附真实下单演示`
3. `支付系统最难的不是下单：状态机、乱序回调、对账，这套项目全跑通了`

### 简介（发布页正文）

```
这 4 分钟，把「云枢支付 PivotPay」从领域模型讲到真实运行。

不是 PPT 架构图：7 个限界上下文、PaymentOrder 聚合根状态机、加权健康度路由与三态熔断、
订单 + 复式分录 + Outbox 同事务、Webhook 退避与死信、日终对账、HMAC 签名与租户隔离，
最后用真实运行的 SaaS 控制台跑一遍：HMAC 签名下单 → 收银台二维码 → 重复/乱序/篡改金额回调 →
通道故障注入与 failover 轨迹 → 对账、账务、审计、切换租户。

技术栈：NestJS + TypeScript / React 19 + Meta 开源 Astryx 设计系统 / Node 22 内置 SQLite
验证：43 项端到端冒烟测试全通过，tsc 零错误，vite build 通过
规格：1080p 25fps，中英双语烧录字幕，外挂 SRT
源码与文档：https://github.com/clawgeek/pivotpay

章节
00:00 封面
00:04 项目定位
00:20 合规边界
00:37 七个限界上下文
00:57 四层架构与技术选型
01:16 订单状态机与领域不变量
01:32 选路 / 熔断 / failover
01:52 事务一致性与复式记账
02:08 开放接口安全与多租户
02:24 实机：驾驶舱与支付订单
02:39 实机：支付沙箱真实签名下单
02:59 实机：通道配置与故障演练
03:15 实机：通知 / 对账 / 账务 / 审计
03:29 43 项测试与工程化
03:44 总结与生产化演进

说明：本项目为教学演示用的沙箱系统，四条模拟通道 + 三条持牌通道的适配器接口占位，
不接入真实资金、不提供支付服务，不实现个人收款码免签 / 二清 / 资金池。
生产化仍需替换 KMS、SSO+RBAC、PostgreSQL、Redis 与消息队列。
源码与文档：https://github.com/clawgeek/pivotpay
仓库里 README 是启动入口，docs/ 含 DDD 设计、API 清单与合规说明，欢迎 star / 提 issue 交流。
```

### 标签

`DDD` `领域驱动设计` `支付系统` `NestJS` `TypeScript` `React` `高可用` `微服务架构` `软件架构` `毕业设计` `项目实战` `编程`

> 若不想强调「毕业设计」，把最后一个换成 `开源项目` 或 `后端开发`。

### 评论区置顶

```
置顶 | 视频里所有界面都是真实运行的系统 + 真实接口数据，不是静态复刻：
HMAC 签名由浏览器 Web Crypto 计算，二维码、回调演练、故障切换轨迹都来自当次请求。

常被问到的三个点：
1. 为什么全用 Mock 通道？—— 教学演示不需要真实资金，持牌通道只留适配器接口与配置位，默认停用。
2. 领域层真的不依赖框架吗？—— 领域层是纯 TypeScript，替换数据库 / MQ 只动基础设施与适配层。
3. 能直接上生产吗？—— 不能，还差 KMS、SSO+RBAC、PostgreSQL、Redis、CDC/MQ 和多副本幂等消费。

源码与完整目录：https://github.com/clawgeek/pivotpay
README 是启动入口；docs/ddd-design.md 讲限界上下文与状态机，docs/api-reference.md 是接口清单，docs/compliance.md 是合规边界。
```

### 动态 / 短动态

```
新视频上线｜4 分钟，把一套 DDD 高可用支付平台从聚合根讲到真实下单演示。
7 个限界上下文 · 状态机 · 熔断 failover · Outbox · 复式记账 · 43 项测试全绿。
1080p 中英双语字幕，章节已打点，建议从 02:39 的支付沙箱开始看。
源码：https://github.com/clawgeek/pivotpay
```

---

## 2. 微信公众号（长图文 / 推文）

**标题**：`把高可用支付平台从架构图写成代码：4 分钟完整导览`

**副标题 / 摘要**：`七个限界上下文、一个订单状态机，和 43 项跑得通的测试。`

**正文**：

```
很多「支付系统」项目，讲到下单和回调就结束了。
真正决定这套系统能不能用的，是后面那些不出现在演示截图里的东西：
迟到的成功回调会不会覆盖已退款的订单？主通道挂了谁来决定换哪条？
通知发了三次都失败，账和订单还对得上吗？

云枢支付 PivotPay 是一次把这些问题写进代码的尝试。

【一 · 先划边界】
只做沙箱通道的模拟资金流。四条模拟通道覆盖成功、超时、失败与乱序回调；
三条持牌通道保留适配器接口与配置位，默认停用、不发真实请求。
个人收款码免签、二清、资金池一律不实现。边界清楚了，架构才谈得上干净。

【二 · 领域层】
七个限界上下文：租户、支付、通道路由、通道适配、通知、对账、账务与审计。
共享内核提供聚合根、值对象、金额、领域事件；防腐层把第三方报文挡在领域模型之外。
PaymentOrder 是聚合根：状态迁移只能走显式状态机，累计退款不得超过实付，
乱序与重复回调不能覆盖终态。

【三 · 高可用】
加权健康度选路，EWMA 延迟与连续失败实时反馈；熔断器在关闭 / 打开 / 半开之间切换；
主通道失败最多自动切换两次，每次尝试都落库可回看。
控制台内置八类故障注入，可以把「通道不可用」「接收端宕机」「注入 800ms 延迟」直接点出来。

【四 · 一致性】
订单、复式分录、Outbox 事件在同一事务里提交，要么全成、要么全滚。
通知走指数退避，超限进死信；日终对账注入短款、长款、状态不一致三类差异，借贷始终平衡。

【五 · 真实运行】
React 19 + Meta 开源 Astryx 设计系统搭的十页 SaaS 控制台。
支付沙箱里，浏览器用 Web Crypto 真算 HMAC-SHA256 签名调用开放接口，
拿到收银台二维码凭证，再演练重复回调、乱序回调、金额篡改与幂等重放。
右上角切换租户，数据立即隔离。

【六 · 验证】
43 项端到端冒烟测试全部通过：签名鉴权、幂等冲突、回调验签与去重、
超额退款、熔断与真实 failover 轨迹、Webhook 重试、对账差异、借贷平衡、跨租户 403。
前后端类型检查零错误，生产构建通过。

【七 · 还没做完的部分】
演示密钥要换 KMS，X-Tenant-Id 要换 SSO+RBAC，
本地 SQLite 与内存 nonce 要换 PostgreSQL + Redis，
进程内 Outbox 轮询要换 CDC / 消息队列。
好消息是：这些替换都只落在基础设施与适配层，领域层一行不用改——这正是 DDD 想要的解耦。

配套 4 分钟讲解视频：1080p、中英双语字幕、含四段真实运行录屏与完整章节打点。
源码与设计文档已放在公开仓库：https://github.com/clawgeek/pivotpay
```

**文末引导**：`源码与文档：https://github.com/clawgeek/pivotpay 。想看哪一块展开讲（状态机 / 对账 / 熔断），留言告诉我。`

---

## 3. 小红书

**标题**：`4 分钟看懂一套 DDD 支付平台｜附真实演示`

**正文**：

```
做支付系统，最容易只做「下单 + 回调」这两步。
这套项目把真正难的部分也写完了 ↓

· 7 个限界上下文，领域层不依赖任何框架
· 订单聚合根状态机：乱序回调、重复回调、超额退款全部挡住
· 加权健康度路由 + 三态熔断 + 自动 failover，8 类故障一键注入
· 订单 / 复式分录 / Outbox 同事务，借贷永远平衡
· HMAC 签名 + nonce + 幂等键 + 租户隔离，跨租户直接 403
· React 19 + Meta 开源 Astryx，10 页 SaaS 控制台，右上角切租户

最喜欢的是支付沙箱：
浏览器真的算 HMAC-SHA256 签名 → 下单 → 出二维码 →
再演重复回调 / 乱序回调 / 改金额，每一步都有日志。

43 项端到端测试全绿，前后端 tsc 零错误，单端口就能跑起来。
4 分钟视频把架构到实机演示都过了一遍，中英双语字幕，章节打好了点。

说明一下：教学演示用的沙箱系统，四条模拟通道，不接真实资金、不提供支付服务，
个人码免签 / 二清 / 资金池都没做，也不建议做。
生产化还差 KMS、SSO、PostgreSQL、Redis、MQ，视频最后也如实讲了。
源码在 GitHub：clawgeek/pivotpay（https://github.com/clawgeek/pivotpay）

#DDD #领域驱动设计 #支付系统 #NestJS #TypeScript #React #后端开发 #软件架构 #项目实战 #编程学习
```

**封面文字（三行）**：`4 分钟 / DDD 高可用支付平台 / 43 项测试全绿`

---

## 4. 知乎（文章 / 回答开头）

**标题**：`用 DDD 写一套支付系统，最难的部分其实不在下单`

**开头 + 要点**：

```
先说结论：支付系统的复杂度不在「调起支付」，而在状态与一致性。
我按这个思路实现了一套可运行的沙箱平台，4 分钟视频是它的完整导览。

几个值得讨论的取舍：

1. 为什么用聚合根而不是「service 里改 status」
   状态迁移集中在 PaymentOrder 的方法里，非法迁移在编译期之外还有一层运行时 invariants。
   终态不可被迟到的成功回调覆盖，累计退款由聚合根自己累加校验。

2. 回调的去重顺序有个坑
   「先验签 → 核对金额与币种 → 再去重」和「先去重」看起来等价，其实不然：
   同流水号 + 篡改金额的伪造报文，如果先查去重表，会被当作重复回调静默放过。
   这条是端到端测试逼出来的，不是设计阶段想到的。

3. 事务边界画在哪
   订单、复式分录、Outbox 事件同库同事务；通知允许最终一致，走指数退避 + 死信。
   把「必须强一致」和「可以最终一致」分开，比全塞进一个分布式事务划算得多。

4. 通道是运行时实体，不是配置项
   健康分、熔断状态、权重都是可变的；故障注入不是 mock 数据，而是真的改变下一次选路结果。

5. 全 Mock 是不是取巧
   教学演示不需要真实资金。四条模拟通道覆盖成功 / 超时 / 失败 / 乱序，
   三条持牌通道只留适配器接口与配置位，默认停用，不发真实请求。
   个人码免签、二清、资金池这类规避监管的玩法，明确不做。

局限也写清楚：演示密钥明文、租户靠请求头、SQLite 单机、Outbox 进程内轮询。
这些替换只涉及基础设施与适配层，领域层不用改，但**没替换之前不能叫生产可用**。

43 项端到端测试、前后端类型检查与生产构建都跑过，视频里有真实运行录屏。
源码与文档：https://github.com/clawgeek/pivotpay
```

---

## 5. 微博（短版 + 长版）

**短版（140 字内）**：

```
4 分钟，把一套 DDD 高可用支付平台从聚合根讲到真实下单演示。
7 个限界上下文 / 订单状态机 / 熔断 failover / Outbox + 复式记账 / HMAC + 租户隔离，
最后 43 项端到端测试全绿。中英双语字幕，02:39 起是实机演示。
教学沙箱系统，不接真实资金、不提供支付服务。
源码：https://github.com/clawgeek/pivotpay
```

**长版**：在短版后追加「技术栈 NestJS+React19+Astryx+Node22 内置 SQLite，零外部服务，单端口 3001；生产化还差 KMS/SSO/PostgreSQL/Redis/MQ，视频最后如实讲了；源码 https://github.com/clawgeek/pivotpay。」

**话题**：`#DDD#` `#支付系统#` `#NestJS#` `#软件架构#` `#编程#`

---

## 6. LinkedIn / X（英文）

**LinkedIn**：

```
I spent the last stretch building PivotPay, a DDD-based cloud payment platform —
and recorded a 4-minute walkthrough of the whole thing.

Not a slideware architecture. Seven bounded contexts, a PaymentOrder aggregate with an
explicit state machine, weighted health routing with a three-state circuit breaker and
automatic failover, an outbox that commits with the order and its double-entry postings,
exponential-backoff webhooks with a dead-letter queue, daily reconciliation, and
HMAC-signed open APIs with tenant isolation.

The console is React 19 on Meta's open-source Astryx design system. In the sandbox,
the browser actually computes an HMAC-SHA256 signature with Web Crypto, places an order,
renders the checkout QR, and then replays duplicate, out-of-order and tampered callbacks.

43 end-to-end smoke checks pass. Type checks and the production build are clean.
1080p, bilingual subtitles, chapters included.

Scope matters: this is a teaching sandbox with four simulated channels. No real funds,
no payment service, no unlicensed clearing. Production would still need a KMS, SSO/RBAC,
PostgreSQL, Redis and a real message broker — all of which sit outside the domain layer,
which is rather the point of the exercise.

Code and docs: https://github.com/clawgeek/pivotpay
```

**X / Twitter（单条）**：

```
4 min walkthrough of PivotPay — a DDD cloud payment platform that actually runs.

7 bounded contexts · aggregate state machine · health routing + circuit breaker + failover
· outbox + double-entry ledger · HMAC + idempotency + tenant isolation · 43 E2E checks green.

1080p, bilingual subs, real UI capture. Sandbox only, no real funds.
Code: https://github.com/clawgeek/pivotpay
```

---

## 7. 抖音 / 视频号（横屏 4 分钟完整版 或 竖屏切条）

**封面大字**：`支付系统最难的不是下单`

**视频标题**：`4 分钟：DDD 高可用支付平台，从聚合根到真实下单`

**15 秒口播钩子（竖屏切条用）**：

```
「下单 + 回调」只占支付系统两成工作量。
剩下八成是：迟到的成功回调会不会覆盖已退款订单？
主通道挂了自动换哪条？通知重试到死信，账还对得上吗？
这 4 分钟，用一套真能跑的系统把答案走一遍。
```

**发布描述**：

```
4 分钟完整版 / 中英双语字幕 / 含真实系统录屏
02:24 驾驶舱 · 02:39 真实签名下单与二维码 · 02:59 故障注入与 failover · 03:29 43 项测试
教学演示沙箱，不接真实资金、不提供支付服务。
源码与文档：https://github.com/clawgeek/pivotpay
```

---

## 8. 封面文案（三版，供封面图 A/B）

| 版本 | 主标题 | 副标题 | 角标 |
| --- | --- | --- | --- |
| A 技术向 | `DDD 高可用支付平台` | `7 个限界上下文 · 状态机 · 熔断 failover` | `4 MIN` |
| B 结果向 | `43 项测试全绿` | `从聚合根到真实签名下单` | `1080P` |
| C 悬念向 | `支付系统最难的不是下单` | `乱序回调 / 对账 / 一致性怎么落地` | `实机演示` |

---

## 9. 通用话题标签池

`DDD` `领域驱动设计` `支付系统` `高可用架构` `NestJS` `TypeScript` `React19` `Astryx`
`聚合根` `状态机` `熔断` `分布式一致性` `Outbox` `复式记账` `对账` `HMAC` `幂等`
`多租户` `SaaS` `软件架构` `项目实战` `后端开发`

英文：`#DDD #DomainDrivenDesign #PaymentSystems #NestJS #TypeScript #React #SoftwareArchitecture #HighAvailability #EventDriven`

---

## 10. 发布前检查 / 合规口径（务必保留）

必带一句（可放在简介末尾或评论区置顶）：

> 本项目为教学演示用的沙箱系统：四条模拟通道 + 三条持牌通道的适配器接口占位，
> 不接入真实资金、不提供支付服务，不实现个人收款码免签 / 二清 / 资金池。
> 生产使用需具备相应支付业务资质，并替换 KMS、SSO+RBAC、PostgreSQL、Redis 与消息队列。

其他注意：

- 不出现「可直接上生产」「资金安全」「支持真实收款」等表述；演示密钥是明文种子数据。
- 不写具体第三方通道的对接教程或密钥；三条持牌通道只提「适配器接口占位」。
- 视频里数字来自种子数据与当次真实请求，换库重跑会变，文案里用「43 项测试全绿」这类稳定事实，不用具体金额。
- 源码已推送到公开仓库 https://github.com/clawgeek/pivotpay；B 站简介、评论区置顶、各平台文末与视频页脚均已写入该地址。换地址时改 `_gen/update_social.py` 的 `REPO` 常量重跑，并同步 `_gen/make_footer.py`。
- 公开仓库不要提交 `.env`、数据库文件与任何真实密钥；`.gitignore` 已排除 node_modules / dist / data/*.db / _video_parse。
- 视频章节时间点对应 `video/page_timeline.json`；重新剪辑后要同步更新简介里的时间轴。
