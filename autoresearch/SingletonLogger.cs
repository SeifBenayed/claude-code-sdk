using System;
using System.IO;
using System.Threading;

public sealed class SingletonLogger
{
    private static SingletonLogger? _instance;
    private static readonly object InstanceLock = new();

    private readonly object _writeLock = new();
    private readonly string _logFilePath;

    private SingletonLogger(string logFilePath)
    {
        _logFilePath = logFilePath;
    }

    public static SingletonLogger GetInstance(string logFilePath = "app.log")
    {
        if (_instance == null)
        {
            lock (InstanceLock)
            {
                if (_instance == null)
                {
                    _instance = new SingletonLogger(logFilePath);
                }
            }
        }

        return _instance;
    }

    public void Log(string message)
    {
        var logEntry = $"[{DateTime.UtcNow:O}] [Thread {Thread.CurrentThread.ManagedThreadId}] {message}{Environment.NewLine}";

        lock (_writeLock)
        {
            File.AppendAllText(_logFilePath, logEntry);
        }
    }
}

public static class Program
{
    public static void Main()
    {
        var logger = SingletonLogger.GetInstance("application.log");
        logger.Log("Application started.");

        var sameLogger = SingletonLogger.GetInstance();
        sameLogger.Log("This uses the same singleton instance.");
    }
}
