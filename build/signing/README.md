# 桌面包代码签名材料（自签名）

Morrow-0.2.0-setup.exe 与 Morrow-0.2.0-portable.exe 用这张自签名证书做 Authenticode 签名。
签名能证明「文件由这张证书的持有者签发、发布后未被篡改」，但**证书本身不是受信任 CA 签发的**：
Windows SmartScreen 仍会提示未知发布者，需要选择「更多信息 → 仍要运行」。

| 项 | 值 |
| --- | --- |
| 主题 | CN=Morrow Studio, O=Morrow Studio, C=CN |
| SHA-1 指纹 | B5BF433D707CB11DA0A2E558DA98C4BFDF6C69C1 |
| 有效期 | 2026-11-21 → 2031-11-21 |
| 用途 | Code Signing（2.5.29.37 = 1.3.6.1.5.5.7.3.3） |
| PFX 口令 | Morrow-0.2.0-SelfSigned |

## 使用者如何自行校验

`powershell
# 1) 哈希与发布说明一致
Get-FileHash .\Morrow-0.2.0-portable.exe -Algorithm SHA256

# 2) 签名主体与指纹与本文档一致（Status 为 UnknownError 属正常：自签名不在受信任根里）
Get-AuthenticodeSignature .\Morrow-0.2.0-portable.exe | Format-List Status, SignerCertificate

# 3) 想让它不再提示：把 morrow-codesign.cer 导入「受信任的根证书颁发机构」
Import-Certificate -FilePath .\morrow-codesign.cer -CertStoreLocation Cert:\CurrentUser\Root
`

## 换正式证书

打包脚本读取的是环境变量，不写死证书：
MORROW_SIGN_PFX + MORROW_SIGN_PFX_PASSWORD（或 MORROW_SIGN_THUMBPRINT / MORROW_SIGN_SUBJECT）。
拿到 CA 签发的代码签名证书后，改这两个变量即可，无需改代码。
