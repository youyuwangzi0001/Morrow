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
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class MorrowLauncher
{
    // 版本与运行时目录由打包脚本根据 package.json 生成，避免升级后启动器仍指向旧版本。
    private const string AppFolderName = ".morrow-runtime-" + MorrowLauncherBuildInfo.Version + "-" + MorrowLauncherBuildInfo.RuntimeRevision;
    private const string AppExeName = "Morrow-app.exe";
    private const string ZipResourceName = "MorrowApp.zip";
    private const string RuntimeStampFile = ".morrow-runtime-complete";
    private const string BrokerArgument = "--shell-broker";
    private static string cachedRuntimeStamp;
#if FOLDER_MODE
    private const bool FolderMode = true;
#else
    private const bool FolderMode = false;
#endif

    [MTAThread]
    private static int Main(string[] args)
    {
        // 受限 Shell 代理进程：只提供命名管道服务，不再解压或启动应用。
        if (args != null && args.Length >= 2 && args[0] == BrokerArgument)
        {
            RunShellBroker(args[1]);
            return 0;
        }

        string exePath = Assembly.GetExecutingAssembly().Location;
        string exeDir = Path.GetDirectoryName(exePath);
        string exeRuntimeDir = Path.Combine(exeDir, AppFolderName);
        string appDir = FolderMode ? exeDir : exeRuntimeDir;
        if (!FolderMode)
        {
            // 上次因 exe 同级目录被占用而回退到 LOCALAPPDATA 时，继续复用该缓存。
            string savedDir = ReadRuntimeLocation(exeDir);
            if (savedDir != null && RuntimeIsCurrent(savedDir)) appDir = savedDir;
        }
        string appExe = Path.Combine(appDir, AppExeName);
        string brokerTask = null;

        try
        {
            // 单文件版必须校验缓存是否对应当前内嵌包：只按版本号判断会让同版本重建继续运行旧代码。
            bool runtimeReady = FolderMode ? File.Exists(appExe) : RuntimeIsCurrent(appDir);
            if (!runtimeReady)
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
                appDir = exeRuntimeDir;
                appExe = Path.Combine(appDir, AppExeName);
                TryDeleteStaleRuntime(appDir);
                string installedDir;
                bool ok = TryExtract(appDir, exeDir, out installedDir);
                if (!ok)
                {
                    MessageBox.Show(
                        "Morrow 无法更新运行文件。\n\n如果 Morrow 正在运行，请先完全退出再启动；否则请把 Morrow 放到有写入权限的文件夹（例如桌面或文档目录）后再试。",
                        "Morrow 启动失败",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return 1;
                }
                // 回退到 LOCALAPPDATA 时，实际运行目录是 installedDir，不能再用 exe 同级路径。
                appDir = installedDir;
                appExe = Path.Combine(appDir, AppExeName);
            }

            string tempDir = Path.Combine(appDir, ".morrow-temp");
            Directory.CreateDirectory(tempDir);

            // Electron 直接创建 explorer.exe 会以 0xC0000142 失败；受限作业对象下即使
            // PowerShell/Shell COM 也会被拒绝。把代理放进任务计划程序：任务由系统服务
            // 在自己的进程里拉起，脱离应用的作业与令牌限制，再用现有 Explorer 打开目标。
            string brokerPipe = NewBrokerPipe();
            bool externalBroker = StartScheduledShellBroker(brokerPipe, out brokerTask);
            if (!externalBroker)
            {
                // 任务代理不可用时退回进程内代理；普通桌面会话来仍能正常工作。
                brokerPipe = NewBrokerPipe();
            }

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
            startInfo.EnvironmentVariables["MORROW_LAUNCHER_PIPE"] = brokerPipe;

            Process appProcess = Process.Start(startInfo);
            if (appProcess == null)
            {
                throw new InvalidOperationException("Morrow-app.exe 未能启动。");
            }
            // 应用退出后由后台监视线程结束启动器与外部代理；主线程继续提供代理服务。
            Thread monitor = new Thread(() =>
            {
                int code = 1;
                try
                {
                    appProcess.WaitForExit();
                    code = appProcess.ExitCode;
                }
                catch
                {
                    code = 1;
                }
                SendBrokerShutdown(brokerPipe);
                if (!string.IsNullOrEmpty(brokerTask)) DeleteScheduledTask(brokerTask);
                Environment.Exit(code);
            });
            monitor.IsBackground = true;
            monitor.Name = "MorrowAppMonitor";
            monitor.Start();

            if (externalBroker)
            {
                // 外部代理已持有命名管道；等监视线程发送 SHUTDOWN 并删除任务后再退出，
                // 否则主线程先返回会截断后台清理，留下隐藏任务和孤儿代理进程。
                appProcess.WaitForExit();
                monitor.Join(10000);
                return appProcess.ExitCode;
            }
            RunShellBroker(brokerPipe);
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Morrow 启动失败：\n" + ex.Message + "\n\n可尝试删除 exe 同级的 " + AppFolderName + " 文件夹后重试。",
                "Morrow 启动失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }

    /// <summary>
    /// 启动一个仅服务于本次 Morrow 进程的命名管道代理。
    /// 命令格式：OPEN/REVEAL/SHUTDOWN + 空格 + UTF-8 路径的 Base64。返回 OK 或 ERR\t原因。
    /// </summary>
    private static void RunShellBroker(string pipeName)
    {
        // explorer.exe 启动失败时不要弹出系统错误框（0xC0000142）。
        SetErrorMode(0x0001 | 0x0002 | 0x4000);
        while (true)
        {
            try
            {
                using (NamedPipeServerStream server = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.None))
                {
                    server.WaitForConnection();
                    using (StreamReader reader = new StreamReader(server, new UTF8Encoding(false), false, 1024, true))
                    using (StreamWriter writer = new StreamWriter(server, new UTF8Encoding(false), 1024, true))
                    {
                        string line = reader.ReadLine();
                        string trimmed = (line ?? string.Empty).Trim();
                        if (trimmed.Equals("SHUTDOWN", StringComparison.OrdinalIgnoreCase) ||
                            trimmed.StartsWith("SHUTDOWN ", StringComparison.OrdinalIgnoreCase))
                        {
                            return;
                        }
                        string response = HandleShellRequestWithTimeout(line);
                        writer.Write(response + "\n");
                        writer.Flush();
                    }
                }
            }
            catch
            {
                Thread.Sleep(50);
            }
        }
    }

    private static string HandleShellRequestWithTimeout(string line)
    {
        string response = "ERR\t系统 Shell 未响应";
        Thread worker = new Thread(() =>
        {
            try
            {
                response = HandleShellRequest(line);
            }
            catch (Exception ex)
            {
                response = "ERR\t" + CleanMessage(ex.Message);
            }
        });
        worker.IsBackground = true;
        worker.Name = "MorrowShellRequest";
        worker.Start();
        if (!worker.Join(5000)) return "ERR\t系统 Shell 未响应";
        return response;
    }

    private static string NewBrokerPipe()
    {
        return "morrow-launcher-" + Guid.NewGuid().ToString("N");
    }

    private const string BrokerTaskPrefix = "MorrowShellBroker-";

    /// <summary>
    /// 任务计划程序由系统服务拉起代理，进程不继承 Electron/启动器的作业对象。
    /// 受限会话里 Electron 自己创建 explorer.exe 会 0xC0000142，只有这个入口能稳定打开窗口。
    /// </summary>
    private static bool StartScheduledShellBroker(string pipeName, out string taskName)
    {
        string candidate = BrokerTaskPrefix + Guid.NewGuid().ToString("N").Substring(0, 12);
        taskName = null;
        string self = Assembly.GetExecutingAssembly().Location;
        string powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(powershell)) return false;
        string user = WindowsIdentity.GetCurrent().Name;
        bool started = false;

        Thread setup = new Thread(() =>
        {
            object service = null;
            object folder = null;
            object task = null;
            object principal = null;
            object settings = null;
            object actions = null;
            object action = null;
            object registered = null;
            try
            {
                Type serviceType = Type.GetTypeFromProgID("Schedule.Service");
                if (serviceType == null) return;
                service = Activator.CreateInstance(serviceType);
                InvokeCom(service, "Connect");
                folder = InvokeCom(service, "GetFolder", "\\");
                CleanupStaleBrokerTasks(folder);
                task = InvokeCom(service, "NewTask", 0);
                principal = GetCom(task, "Principal");
                SetCom(principal, "UserId", user);
                SetCom(principal, "LogonType", 3);
                SetCom(principal, "RunLevel", 0);
                settings = GetCom(task, "Settings");
                SetCom(settings, "Hidden", true);
                SetCom(settings, "AllowDemandStart", true);
                SetCom(settings, "Enabled", true);
                SetCom(settings, "DisallowStartIfOnBatteries", false);
                SetCom(settings, "StopIfGoingOnBatteries", false);
                SetCom(settings, "ExecutionTimeLimit", "PT0S");
                actions = GetCom(task, "Actions");
                action = InvokeCom(actions, "Create", 0);
                // 直接以中文目录里的 exe 作为任务动作会被计划程序判为找不到文件；
                // 用 ASCII 的 powershell.exe 作为动作，再由它启动代理，Unicode 路径保持在参数里。
                string brokerCommand = "-NoProfile -NonInteractive -WindowStyle Hidden -Command \"Start-Process -FilePath '" +
                    self.Replace("'", "''") + "' -ArgumentList '--shell-broker " + pipeName + "' -WindowStyle Hidden\"";
                SetCom(action, "Path", powershell);
                SetCom(action, "Arguments", brokerCommand);
                SetCom(action, "WorkingDirectory", Environment.SystemDirectory);
                InvokeCom(folder, "RegisterTaskDefinition", candidate, task, 6, user, null, 3, null);
                registered = InvokeCom(folder, "GetTask", candidate);
                InvokeCom(registered, "Run", new object[] { null });
                started = true;
            }
            catch
            {
                started = false;
            }
            finally
            {
                ReleaseCom(registered);
                ReleaseCom(action);
                ReleaseCom(actions);
                ReleaseCom(settings);
                ReleaseCom(principal);
                ReleaseCom(task);
                ReleaseCom(folder);
                ReleaseCom(service);
            }
        });
        setup.SetApartmentState(ApartmentState.STA);
        setup.IsBackground = true;
        setup.Name = "MorrowBrokerTaskSetup";
        setup.Start();
        if (!setup.Join(15000) || !started)
        {
            DeleteScheduledTask(candidate);
            return false;
        }
        if (!WaitForPipeReady(pipeName, 12000))
        {
            DeleteScheduledTask(candidate);
            return false;
        }
        taskName = candidate;
        return true;
    }

    private static void CleanupStaleBrokerTasks(object folder)
    {
        object tasks = null;
        try
        {
            tasks = InvokeCom(folder, "GetTasks", 1);
            int count = Convert.ToInt32(GetCom(tasks, "Count"));
            for (int i = count - 1; i >= 0; i--)
            {
                object item = null;
                try
                {
                    item = GetComAt(tasks, "Item", i);
                    string name = Convert.ToString(GetCom(item, "Name"));
                    if (string.IsNullOrEmpty(name) || !name.StartsWith(BrokerTaskPrefix, StringComparison.Ordinal)) continue;
                    int state = Convert.ToInt32(GetCom(item, "State"));
                    if (state == 4) continue; // 运行中的任务可能属于另一个实例
                    try { InvokeCom(folder, "DeleteTask", name, 0); } catch { }
                }
                catch
                {
                    // 单个任务读取失败不影响启动
                }
                finally
                {
                    ReleaseCom(item);
                }
            }
        }
        catch
        {
            // 清理失败不阻断代理启动
        }
        finally
        {
            ReleaseCom(tasks);
        }
    }

    private static void DeleteScheduledTask(string taskName)
    {
        if (string.IsNullOrEmpty(taskName)) return;
        Thread cleanup = new Thread(() =>
        {
            object service = null;
            object folder = null;
            object task = null;
            try
            {
                Type serviceType = Type.GetTypeFromProgID("Schedule.Service");
                if (serviceType == null) return;
                service = Activator.CreateInstance(serviceType);
                InvokeCom(service, "Connect");
                folder = InvokeCom(service, "GetFolder", "\\");
                Thread.Sleep(300);
                try
                {
                    task = InvokeCom(folder, "GetTask", taskName);
                    InvokeCom(task, "Stop", new object[] { null });
                }
                catch { }
                try { InvokeCom(folder, "DeleteTask", taskName, 0); } catch { }
            }
            catch { }
            finally
            {
                ReleaseCom(task);
                ReleaseCom(folder);
                ReleaseCom(service);
            }
        });
        cleanup.SetApartmentState(ApartmentState.STA);
        cleanup.IsBackground = true;
        cleanup.Name = "MorrowBrokerTaskCleanup";
        cleanup.Start();
        cleanup.Join(4000);
    }

    private static object GetCom(object target, string name)
    {
        return target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, null);
    }

    private static object GetComAt(object target, string name, params object[] args)
    {
        return target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, args);
    }

    private static void SetCom(object target, string name, object value)
    {
        target.GetType().InvokeMember(name, BindingFlags.SetProperty, null, target, new object[] { value });
    }

    private static object InvokeCom(object target, string name, params object[] args)
    {
        return target.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, target, args);
    }

    private static void ReleaseCom(object value)
    {
        if (value != null && Marshal.IsComObject(value))
        {
            try { Marshal.ReleaseComObject(value); } catch { }
        }
    }

    private static bool WaitForPipeReady(string pipeName, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using (NamedPipeClientStream client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out))
                {
                    client.Connect(300);
                    return true;
                }
            }
            catch
            {
                Thread.Sleep(100);
            }
        }
        return false;
    }

    private static void SendBrokerShutdown(string pipeName)
    {
        try
        {
            using (NamedPipeClientStream client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out))
            {
                client.Connect(1000);
                using (StreamWriter writer = new StreamWriter(client, new UTF8Encoding(false), 1024, true))
                {
                    writer.Write("SHUTDOWN\n");
                    writer.Flush();
                }
            }
        }
        catch
        {
            // 代理未就绪或已退出时无需处理。
        }
    }

    [DllImport("kernel32.dll")]
    private static extern uint SetErrorMode(uint mode);

    /// <summary>由现有 Explorer 完成打开/定位；不使用会挂起或拒绝的 Shell COM/ShellExecuteEx。</summary>
    private static bool StartExplorer(string arguments)
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo("explorer.exe", arguments)
            {
                UseShellExecute = false,
                WorkingDirectory = Environment.SystemDirectory
            };
            using (Process process = Process.Start(info))
            {
                if (process == null) return false;
                if (!process.WaitForExit(1500)) return true;
                // explorer.exe 正常把请求转交现有 Shell 后以 1 退出；0xC0000142 表示启动失败。
                return process.ExitCode != unchecked((int)0xC0000142);
            }
        }
        catch
        {
            return false;
        }
    }

    private static string HandleShellRequest(string line)
    {
        try
        {
            if (string.IsNullOrEmpty(line))
            {
                return "ERR\t空请求";
            }
            int space = line.IndexOf(' ');
            string command = (space < 0 ? line : line.Substring(0, space)).Trim().ToUpperInvariant();
            string encoded = space < 0 ? string.Empty : line.Substring(space + 1).Trim();
            string target = Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
            if (string.IsNullOrEmpty(target) || !Path.IsPathRooted(target))
            {
                return "ERR\t路径无效";
            }
            bool isFile = File.Exists(target);
            bool isDirectory = Directory.Exists(target);
            if (!isFile && !isDirectory)
            {
                return "ERR\t文件不存在";
            }


            if (command == "OPEN")
            {
                // 目录打开窗口，文件交给关联程序；两者都由已运行的 Explorer 接单。
                return StartExplorer("\"" + target + "\"") ? "OK" : "ERR\t系统文件管理器未能打开目标";
            }

            if (command == "REVEAL")
            {
                if (isDirectory) return StartExplorer("\"" + target + "\"") ? "OK" : "ERR\t系统文件管理器未能打开文件夹";
                return StartExplorer("/select,\"" + target + "\"") ? "OK" : "ERR\t系统文件管理器未能定位目标";
            }

            return "ERR\t未知命令";
        }
        catch (Exception ex)
        {
            return "ERR\t" + CleanMessage(ex.Message);
        }
    }

    private static string CleanMessage(string message)
    {
        return (message ?? string.Empty).Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
    }

    /// <summary>内嵌应用 zip 的 SHA-256；用作运行时缓存的版本指纹。</summary>
    private static string GetRuntimeStamp()
    {
        if (!string.IsNullOrEmpty(cachedRuntimeStamp)) return cachedRuntimeStamp;
        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(ZipResourceName))
        {
            if (resource == null) throw new InvalidOperationException("安装资源缺失（MorrowApp.zip）");
            using (SHA256 sha = SHA256.Create())
            {
                cachedRuntimeStamp = BitConverter.ToString(sha.ComputeHash(resource)).Replace("-", "");
            }
        }
        return cachedRuntimeStamp;
    }

    private static bool RuntimeIsCurrent(string appDir)
    {
        try
        {
            if (!File.Exists(Path.Combine(appDir, AppExeName))) return false;
            string stampPath = Path.Combine(appDir, RuntimeStampFile);
            return File.Exists(stampPath) && File.ReadAllText(stampPath).Trim() == GetRuntimeStamp();
        }
        catch
        {
            return false;
        }
    }

    private static void TryDeleteStaleRuntime(string appDir)
    {
        try
        {
            if (Directory.Exists(appDir)) Directory.Delete(appDir, true);
        }
        catch
        {
            // 旧进程仍占用时交给解压覆盖；若仍失败，TryExtract 会回退到 LOCALAPPDATA
        }
    }

    /// <summary>读取上次回退到 LOCALAPPDATA 的运行目录；没有或不可读时返回 null。</summary>
    private static string ReadRuntimeLocation(string exeDir)
    {
        try
        {
            string file = Path.Combine(exeDir, ".morrow-runtime-location");
            if (!File.Exists(file)) return null;
            string dir = File.ReadAllText(file).Trim();
            return string.IsNullOrEmpty(dir) ? null : dir;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>顶层目录可写则解压到 exe 目录；否则回退 LOCALAPPDATA。usedDir 是实际可用目录。</summary>
    private static bool TryExtract(string appDir, string exeDir, out string usedDir)
    {
        usedDir = appDir;
        string fallbackDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Morrow",
            "runtime-" + MorrowLauncherBuildInfo.Version);

        if (InnerExtract(appDir))
        {
            try
            {
                File.Delete(Path.Combine(exeDir, ".morrow-runtime-location"));
            }
            catch
            {
                // 无写入权限时忽略
            }
            return true;
        }
        if (InnerExtract(fallbackDir))
        {
            usedDir = fallbackDir;
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
            File.WriteAllText(Path.Combine(targetDir, RuntimeStampFile), GetRuntimeStamp());
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
