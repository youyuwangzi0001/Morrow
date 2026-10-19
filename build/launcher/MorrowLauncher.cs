// Morrow 单文件启动器（自研，替代 electron-builder 的 NSIS 自解压壳）
//
// 背景：electron-builder 的 portable 目标是 NSIS 自解压，把应用解压到 %TEMP%，
// 从受限入口（如工作流面板）启动时 %TEMP% 不可写会报 “Error writing temporary file”。
// 本启动器把应用以 zip 资源内嵌在自身，首次运行时解压到 exe 同级的隐藏缓存目录
// `.morrow-runtime-<ver>`（不依赖 %TEMP%），之后直接复用；exe 目录只读时回退到
// %LOCALAPPDATA%\Morrow\runtime-<ver>。
//
// 两种编译形态：
//   单文件版：csc ... -resource:app.zip,MorrowApp.zip MorrowLauncher.cs
//   文件夹版：csc ... -define:FOLDER_MODE MorrowLauncher.cs（输出为文件夹里的 Morrow.exe，
//            启动同目录的 Morrow-app.exe；不再需要内部 zip）
// 两种形态都会给应用追加 --no-sandbox：本机/受限启动环境下 Chromium 沙箱会在初始化阶段
// 直接崩溃（0x80000003，进程秒退、无窗口），而应用只渲染本地内容，工具层仍有工作区沙箱与
// 审批机制；这是为了让双击一定能打开的兼容性取舍。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Morrow")]
[assembly: AssemblyProduct("Morrow")]
[assembly: AssemblyDescription("Morrow - 住在你电脑里的 AI 工作伙伴")]
[assembly: AssemblyCompany("Morrow Studio")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: AssemblyInformationalVersion("1.0.0")]

internal static class MorrowLauncher
{
    private const string Version = "1.0.0";
    private const string AppFolderName = ".morrow-runtime-" + Version;
    private const string AppExeName = "Morrow-app.exe";
    private const string ZipResourceName = "MorrowApp.zip";
#if FOLDER_MODE
    private const bool FolderMode = true;
#else
    private const bool FolderMode = false;
#endif

    [STAThread]
    private static int Main(string[] args)
    {
        string exePath = Assembly.GetExecutingAssembly().Location;
        string exeDir = Path.GetDirectoryName(exePath);
        string appDir = FolderMode ? exeDir : Path.Combine(exeDir, AppFolderName);
        string appExe = Path.Combine(appDir, AppExeName);

        try
        {
            if (!File.Exists(appExe))
            {
                if (FolderMode)
                {
                    MessageBox.Show(
                        "Morrow 运行文件缺失：同目录下找不到 " + AppExeName + "。\n\n请重新解压完整的便携文件夹（不要只拷 Morrow.exe），或使用单文件版。",
                        "Morrow 启动失败",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return 1;
                }
                bool ok = TryExtract(appDir, exeDir);
                if (!ok)
                {
                    MessageBox.Show(
                        "Morrow 无法在程序所在目录写入运行文件。\n\n请把 Morrow 放到有写入权限的文件夹（例如桌面或文档目录）后再试。",
                        "Morrow 启动失败",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return 1;
                }
            }

            string tempDir = Path.Combine(appDir, ".morrow-temp");
            Directory.CreateDirectory(tempDir);

            ProcessStartInfo startInfo = new ProcessStartInfo(appExe);
            startInfo.WorkingDirectory = appDir;
            startInfo.UseShellExecute = false;
            // 从 DSH/工作流终端继承的 ELECTRON_RUN_AS_NODE 会让 Electron 以 Node 模式启动并拒绝 --no-sandbox
            startInfo.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            // 兼容性：本机在带 Chromium 沙箱启动时会在初始化阶段直接崩溃，必须禁用沙箱。
            // 应用仅渲染本地内容；工具权限沙箱、工作区边界与审批不受影响。
            startInfo.Arguments = "--no-sandbox " + JoinArguments(args);
            startInfo.EnvironmentVariables["PORTABLE_EXECUTABLE_DIR"] = exeDir;
            startInfo.EnvironmentVariables["PORTABLE_EXECUTABLE_FILE"] = exePath;
            startInfo.EnvironmentVariables["PORTABLE_EXECUTABLE_APP_FILENAME"] = AppExeName;
            startInfo.EnvironmentVariables["TEMP"] = tempDir;
            startInfo.EnvironmentVariables["TMP"] = tempDir;

            using (Process process = Process.Start(startInfo))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Morrow 启动失败：\n" + ex.Message + "\n\n可尝试删除 exe 同级的 .morrow-runtime-" + Version + " 文件夹后重试。",
                "Morrow 启动失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }

    /// <summary>顶层目录可写则解压到 exe 目录；否则回退 LOCALAPPDATA。返回是否成功。</summary>
    private static bool TryExtract(string appDir, string exeDir)
    {
        string fallbackDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Morrow",
            "runtime-" + Version);

        if (InnerExtract(appDir))
        {
            return true;
        }
        if (InnerExtract(fallbackDir))
        {
            // 记忆回退位置，后续启动直接从 LOCALAPPDATA 运行
            try
            {
                File.WriteAllText(Path.Combine(exeDir, ".morrow-runtime-location"), fallbackDir);
            }
            catch
            {
                // 无写入权限时忽略
            }
            return true;
        }
        return false;
    }

    private static bool InnerExtract(string targetDir)
    {
        try
        {
            Directory.CreateDirectory(targetDir);
            // 写权限探测
            string probe = Path.Combine(targetDir, ".write-test");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);

            using (Splash splash = new Splash())
            {
                splash.Show();
                Application.DoEvents();

                using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(ZipResourceName))
                {
                    if (resource == null)
                    {
                        throw new InvalidOperationException("安装资源缺失（MorrowApp.zip）");
                    }
                    using (ZipArchive archive = new ZipArchive(resource, ZipArchiveMode.Read))
                    {
                        int total = archive.Entries.Count;
                        int index = 0;
                        foreach (ZipArchiveEntry entry in archive.Entries)
                        {
                            index++;
                            string destination = Path.GetFullPath(Path.Combine(targetDir, entry.FullName));
                            string rootPath = Path.GetFullPath(targetDir) + Path.DirectorySeparatorChar;
                            if (!destination.StartsWith(rootPath, StringComparison.OrdinalIgnoreCase))
                            {
                                continue; // 防 zip-slip
                            }
                            if (string.IsNullOrEmpty(entry.Name))
                            {
                                Directory.CreateDirectory(destination);
                                continue;
                            }
                            Directory.CreateDirectory(Path.GetDirectoryName(destination));
                            entry.ExtractToFile(destination, true);
                            if (index % 40 == 0)
                            {
                                splash.SetProgress(index, total);
                                Application.DoEvents();
                            }
                        }
                    }
                }
                splash.Close();
            }
            File.WriteAllText(Path.Combine(targetDir, ".morrow-runtime-complete"), Version);
            return true;
        }
        catch
        {
            try
            {
                if (Directory.Exists(targetDir))
                {
                    Directory.Delete(targetDir, true);
                }
            }
            catch
            {
                // 忽略清理失败
            }
            return false;
        }
    }

    private static string JoinArguments(string[] args)
    {
        if (args == null || args.Length == 0)
        {
            return string.Empty;
        }
        System.Text.StringBuilder builder = new System.Text.StringBuilder();
        foreach (string arg in args)
        {
            if (builder.Length > 0)
            {
                builder.Append(' ');
            }
            builder.Append(Quote(arg));
        }
        return builder.ToString();
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
        {
            return value;
        }
        System.Text.StringBuilder builder = new System.Text.StringBuilder("\"");
        for (int i = 0; i < value.Length; i++)
        {
            if (value[i] == '\\')
            {
                int backslashes = 1;
                while (i + 1 < value.Length && value[i + 1] == '\\')
                {
                    backslashes++;
                    i++;
                }
                builder.Append('\\', backslashes * 2);
            }
            else if (value[i] == '"')
            {
                builder.Append('\\').Append('"');
            }
            else
            {
                builder.Append(value[i]);
            }
        }
        builder.Append('"');
        return builder.ToString();
    }

    /// <summary>首次启动的解压进度小窗（无边框、深色、极简）。</summary>
    private sealed class Splash : Form
    {
        private readonly Label label;
        private readonly ProgressBar bar;

        public Splash()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(13, 15, 19);
            Size = new Size(360, 128);
            ShowInTaskbar = false;
            TopMost = true;

            label = new Label();
            label.Text = "Morrow 正在完成首次启动…";
            label.ForeColor = Color.FromArgb(237, 231, 218);
            label.BackColor = Color.Transparent;
            label.Font = new Font("Microsoft YaHei UI", 10.5f);
            label.AutoSize = true;
            label.Location = new Point(28, 34);
            Controls.Add(label);

            bar = new ProgressBar();
            bar.Style = ProgressBarStyle.Continuous;
            bar.Minimum = 0;
            bar.Maximum = 100;
            bar.Value = 0;
            bar.Location = new Point(28, 74);
            bar.Size = new Size(304, 6);
            Controls.Add(bar);

            Label hint = new Label();
            hint.Text = "正在准备运行文件（仅首次，约几秒）";
            hint.ForeColor = Color.FromArgb(107, 103, 95);
            hint.BackColor = Color.Transparent;
            hint.Font = new Font("Microsoft YaHei UI", 8.5f);
            hint.AutoSize = true;
            hint.Location = new Point(28, 92);
            Controls.Add(hint);

            // 圆角窗口（Windows 11 由系统处理；这里仅给一个细边框观感）
            Paint += (sender, e) =>
            {
                using (Pen pen = new Pen(Color.FromArgb(70, 200, 174, 125), 1))
                {
                    e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
                }
            };
        }

        public void SetProgress(int current, int total)
        {
            if (total <= 0)
            {
                return;
            }
            int percent = (int)(current * 100L / total);
            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;
            bar.Value = percent;
        }
    }
}
