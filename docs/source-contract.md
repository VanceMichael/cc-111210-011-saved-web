# 离线网页封装

`/saved.mhtml` 是 multipart/related 包，`start="<root>"` 指向包内第二个部分，而不是首个 HTML。正文含改变相对地址的 `<base>`、`cid:` 资源、未找到引用、同址异内容及 quoted-printable 正文。

`kind` 提供四种演练材料：

- `normal`（默认）：根文档不在首部，含 cid 资源、缺失引用与同址异内容。
- `truncated`：缺失尾部边界，末段头部和正文被截断。
- `nested`：`start` 指向嵌套 multipart/related 容器，由容器内的 `start` 选定根文档；该正文以 base64 传输并使用 GBK 字符集。
- `cycles`：根文档与其子页面互相引用，构成循环引用。
- `clean`：依赖闭合、无歧义，用于验证 `usable=true` 的接收路径。

查看入口 `/inspect` 与接收入口 `/receive` 都会建立正文、资源清单与引用图。后续接收不得访问材料中的 `exhibit.test` 地址；外部地址只在包内查找，不联网获取。内容均为本地合成字节，不含可执行脚本；脚本与伪协议引用只记录、不执行。

## 采集结果

接收流程为每个部分建立可追溯记录，字段含义如下：

- `package`：字节长度、SHA-256、顶层 `Content-Type` 参数（`boundary`、`start`、`type`）、完整性与截断位置。
- `root`：按 multipart/related 的 `start` 解析出的根部分（其次才看 `type` 参数，最后才用回退规则）；`selection` 记录选定方式，`ROOT_NOT_FIRST` 诊断明确说明根文档不在首部。
- `parts[]`：序号、嵌套深度与父部分、原始字节偏移/长度/SHA-256、解码后长度与 SHA-256、传输编码、Content-ID、Content-Location 与归一化地址。
- `documents[]`：正文文本、字符编码来源（Content-Type / meta / BOM / 默认）、各自的引用清单与依赖闭合结果；`usable` 要求依赖闭合、无缺失、无歧义、无循环、无截断。
- `resources[]`：被引用或被候选指向的资源，含原始字节范围、预览摘要与 `referencedBy`；`candidateFor` 保留同址异内容的每个候选。
- `references[]`：每条引用的原值、解析基址、查找键（归一化地址或 Content-ID）、状态（`resolved`/`missing`/`ambiguous`/`blocked`/`inline`/`local`）与目标部分。地址归一化只用于查找，原值与原始字节偏移始终保留。
- `missing`、`ambiguous`、`cycles`、`unreferencedParts`：缺失、歧义、循环和未引用部分分别独立呈现，互不吞并。
- `diagnostics[]`：带稳定 `code` 的告警，供入口直接展示。

包损坏时解析尽可能保留可读部分：缺失空行只影响头部，缺失结束边界或截断边界标记为不完整。只有根文档依赖闭合且无歧义时 `usable` 才为真；`/receive` 对不可用包返回 409 并附诊断，不写入回执。

接收时按字节流读取并设置上限（默认 16 MB，可用 `maxBytes` 或 `CAPTURE_MAX_BYTES` 调整），超限即停止并拒绝，避免大附件无限占用内存。
