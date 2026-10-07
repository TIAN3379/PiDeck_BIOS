---
name: common-uefi
description: 通用 UEFI/EDK II 源码定位方法：从症状出发找到启动阶段、模块、构建描述与配置入口，不依赖任何特定 IBV 的私有知识。用于“在源码树里这是谁在做事/哪里能改/怎么找到入口”这类定位问题。
---

# 通用 UEFI/EDK II 定位方法

目标：在**没有厂商内部文档**的情况下，用源码证据把"症状 → 阶段 → 模块 → 配置入口"串起来。

## 适用前提

- 本技能只描述 EDK II 公开约定（包/模块/PPI/PROTOCOL/DSC/FDF/DEC/INF 的关系），
  **不声明**支持任何特定 IBV（AMI/Insyde/百敖等）的私有模块命名或私有配置机制。
- 厂商私有内容（闭源 Binary、私有 DXE 驱动、私有 Setup 变量）只能标注"未知"，不得凭常识编造。

## 定位顺序

1. **阶段**：SEC → PEI → DXE → BDS → TSL/Runtime。先判断症状发生在哪个阶段，
   而不是直接搜关键词。判据：串口/内存初始化前 = SEC/PEI；控制台与 Setup 之后 = DXE/BDS；OS 加载后 = TSL/Runtime。
2. **构建描述**：`.dsc`（`[Defines] PLATFORM_NAME`、`!include` 引入的组件与库）、`.fdf`（固件卷与模块布局）、
   `.dec`（包名与 GUID 声明）。先用 `bios_detect_project` 拿**候选**相对路径，再人工确认构建目标。
3. **模块**：从 `.inf` 的 `[Sources]` / `[Packages]` / `[LibraryClasses]` 判断该模块依赖哪些库与协议；
   用 `[Protocols]` / `[Guids]` 找到它 produce/consume 的接口。
4. **配置入口**：Setup 变量通常经 `HII` / `EFI_HII_CONFIG_ROUTING_PROTOCOL` / 平台变量回调暴露；
   PCD 分 `FixedAtBuild` / `PatchableInModule` / `Dynamic*`，`DynamicHii` 才与 Setup 变量绑定。
   找到"哪个 PCD / 哪个 `VarStoreId`"比找到"哪一行代码"更接近根因。
5. **定制区**：客户/板级定制通常位于板级目录或 OEM 包中，表现为重写库实现（`LibraryClass` 覆盖）
   或平台驱动替换。判断依据是 `.dsc`/`.fdf` 里**实际被引用**的文件，而不是目录名。

## 读取纪律

- 用工具读取**有界**范围（单文件、明确路径）；不要为了"看一眼"而递归全仓。
- 引用源码时给相对路径 + 内容 hash（未提交文件没有可靠 commit）。
- 目录名、Git 远端、出现某家芯片的通用库，都**不能**作为构建目标或客户归属的证据。

## 明确不做

- 不做宏求值、不做完整构建闭包解析、不执行源码树里的脚本。
- 不据技术名词匹配就宣称"已适配该平台"。
- 不把"找到了文件"当作"找到了根因"。
