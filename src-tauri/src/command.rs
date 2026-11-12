use super::{connect_ssh, CommandResult, ServerProfile};
use std::{collections::HashMap, sync::Mutex};
use std::{
    io::{ErrorKind, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Default)]
pub(crate) struct CommandManager {
    active: Arc<Mutex<HashMap<String, Arc<CommandControl>>>>,
}

pub(crate) struct CommandRegistration {
    active: Arc<Mutex<HashMap<String, Arc<CommandControl>>>>,
    id: String,
    pub(crate) control: Arc<CommandControl>,
}

impl CommandManager {
    pub(crate) fn register(&self, id: String) -> Result<CommandRegistration, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "命令状态锁已损坏".to_string())?;
        if id.is_empty() || active.contains_key(&id) {
            return Err("命令标识为空或已在运行".to_string());
        }
        let control = Arc::new(CommandControl::default());
        active.insert(id.clone(), control.clone());
        Ok(CommandRegistration {
            active: self.active.clone(),
            id,
            control,
        })
    }
    pub(crate) fn cancel(&self, id: &str) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "命令状态锁已损坏".to_string())?;
        active
            .get(id)
            .ok_or_else(|| "命令不存在或已结束".to_string())?
            .cancel();
        Ok(())
    }
}

impl Drop for CommandRegistration {
    fn drop(&mut self) {
        self.control.cancel();
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if active
            .get(&self.id)
            .is_some_and(|control| Arc::ptr_eq(control, &self.control))
        {
            active.remove(&self.id);
        }
    }
}

pub(crate) struct CommandControl {
    cancelled: AtomicBool,
    timeout: Duration,
    max_bytes: usize,
}

impl CommandControl {
    pub(crate) fn new(timeout: Duration, max_bytes: usize) -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            timeout,
            max_bytes,
        }
    }
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
    fn check(&self, started: Instant) -> Result<(), String> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err("命令已取消".into());
        }
        if started.elapsed() >= self.timeout {
            return Err("命令执行超时，已关闭 SSH 命令通道".into());
        }
        Ok(())
    }
}

impl Default for CommandControl {
    fn default() -> Self {
        Self::new(Duration::from_secs(60), 8 * 1024 * 1024)
    }
}

// Dropping an async caller must also signal the blocking SSH worker.
pub(crate) struct CancelOnDrop(pub(crate) Arc<CommandControl>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

fn retry<T>(
    control: &CommandControl,
    started: Instant,
    mut operation: impl FnMut() -> Result<T, ssh2::Error>,
) -> Result<T, String> {
    loop {
        control.check(started)?;
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if error.code() == ssh2::ErrorCode::Session(-37) => {
                thread::sleep(Duration::from_millis(8))
            }
            Err(error) => return Err(format!("SSH 命令失败: {error}")),
        }
    }
}

fn drain_streams(
    stdout: &mut impl Read,
    stderr: &mut impl Read,
    control: &CommandControl,
    started: Instant,
    is_eof: impl Fn() -> bool,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut outputs = [Vec::new(), Vec::new()];
    let mut ended = [false, false];
    let mut buffer = [0u8; 16 * 1024];
    loop {
        control.check(started)?;
        let mut progress = false;
        // One bounded read per stream keeps noisy stderr from starving stdout (and vice versa).
        for (index, stream) in [&mut *stdout as &mut dyn Read, &mut *stderr as &mut dyn Read]
            .into_iter()
            .enumerate()
        {
            if ended[index] {
                continue;
            }
            match stream.read(&mut buffer) {
                Ok(0) => ended[index] = is_eof(),
                Ok(count) => {
                    if outputs[0].len() + outputs[1].len() + count > control.max_bytes {
                        return Err(format!(
                            "命令输出超过 {} 字节限制，已关闭 SSH 命令通道",
                            control.max_bytes
                        ));
                    }
                    outputs[index].extend_from_slice(&buffer[..count]);
                    progress = true;
                }
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                Err(error) => return Err(format!("读取命令输出失败: {error}")),
            }
        }
        if ended.iter().all(|ended| *ended) {
            return Ok((
                std::mem::take(&mut outputs[0]),
                std::mem::take(&mut outputs[1]),
            ));
        }
        if !progress {
            thread::sleep(Duration::from_millis(8));
        }
    }
}

pub(crate) fn run(
    server: &ServerProfile,
    command: &str,
    control: &CommandControl,
) -> Result<CommandResult, String> {
    control.check(Instant::now())?;
    let session = connect_ssh(server)?;
    run_on_session(&session, command, control)
}

pub(crate) fn run_on_session(
    session: &ssh2::Session,
    command: &str,
    control: &CommandControl,
) -> Result<CommandResult, String> {
    struct RestoreBlocking<'a>(&'a ssh2::Session, bool);
    impl Drop for RestoreBlocking<'_> {
        fn drop(&mut self) {
            self.0.set_blocking(self.1);
        }
    }
    let _blocking = RestoreBlocking(session, session.is_blocking());
    let started = Instant::now();
    session.set_blocking(false);
    let mut channel = retry(control, started, || session.channel_session())?;
    let result = (|| {
        retry(control, started, || channel.exec(command))?;
        retry(control, started, || channel.send_eof())?;
        let (stdout, stderr) = drain_streams(
            &mut channel.stream(0),
            &mut channel.stderr(),
            control,
            started,
            || channel.eof(),
        )?;
        retry(control, started, || channel.wait_close())?;
        Ok(CommandResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code: channel.exit_status().map_err(|error| error.to_string())?,
        })
    })();
    if result.is_err() {
        channel.close().ok();
        session
            .disconnect(None, "command cancelled or bounded", None)
            .ok();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor};
    struct Stalled;
    impl Read for Stalled {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(ErrorKind::WouldBlock.into())
        }
    }

    #[test]
    fn reads_both_streams_and_enforces_total_output_limit() {
        let control = CommandControl::new(Duration::from_secs(1), 4);
        let result = drain_streams(
            &mut Cursor::new(b"ab"),
            &mut Cursor::new(b"cd"),
            &control,
            Instant::now(),
            || true,
        )
        .unwrap();
        assert_eq!(result, (b"ab".to_vec(), b"cd".to_vec()));
        assert!(drain_streams(
            &mut Cursor::new(b"ab"),
            &mut Cursor::new(b"cde"),
            &control,
            Instant::now(),
            || true
        )
        .unwrap_err()
        .contains("输出超过"));
        // stdout never completes; stderr must still be drained and bounded.
        assert!(drain_streams(
            &mut Stalled,
            &mut Cursor::new(b"large stderr"),
            &control,
            Instant::now(),
            || true
        )
        .unwrap_err()
        .contains("输出超过"));
    }

    #[test]
    fn stalled_output_obeys_timeout_and_cancellation() {
        let control = Arc::new(CommandControl::new(Duration::from_millis(10), 100));
        assert!(
            drain_streams(&mut Stalled, &mut Stalled, &control, Instant::now(), || {
                true
            })
            .unwrap_err()
            .contains("超时")
        );
        drop(CancelOnDrop(control.clone()));
        assert!(
            drain_streams(&mut Stalled, &mut Stalled, &control, Instant::now(), || {
                true
            })
            .unwrap_err()
            .contains("取消")
        );
    }

    #[test]
    fn registered_commands_cancel_and_release_their_ids() {
        let manager = CommandManager::default();
        let command = manager.register("operation-1".into()).unwrap();
        assert!(manager.register("operation-1".into()).is_err());
        manager.cancel("operation-1").unwrap();
        assert!(command
            .control
            .check(Instant::now())
            .unwrap_err()
            .contains("取消"));
        drop(command);
        assert!(manager.cancel("operation-1").is_err());
        assert!(manager.register("operation-1".into()).is_ok());
    }

    #[test]
    #[ignore = "requires Python with paramiko; uses only an ephemeral loopback SSH server"]
    fn loopback_ssh_handles_stderr_backpressure_limits_timeout_and_cancel() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        struct Fixture(std::process::Child);
        impl Drop for Fixture {
            fn drop(&mut self) {
                self.0.kill().ok();
                self.0.wait().ok();
            }
        }
        let mut process =
            Command::new(std::env::var("PORTICO_TEST_PYTHON").unwrap_or_else(|_| "python".into()));
        process
            .arg("-u")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../test/sshCommandFixture.py"
            ))
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            process.creation_flags(0x08000000);
        }
        let mut fixture = Fixture(process.spawn().expect("start Python/paramiko fixture"));
        let mut port = String::new();
        std::io::BufReader::new(fixture.0.stdout.take().unwrap())
            .read_line(&mut port)
            .unwrap();
        let port: u16 = port
            .trim()
            .parse()
            .expect("fixture port; ensure paramiko is installed");
        let connect = || {
            let tcp = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
            let mut session = ssh2::Session::new().unwrap();
            session.set_tcp_stream(tcp);
            session.set_timeout(5000);
            session
                .method_pref(ssh2::MethodType::Kex, "diffie-hellman-group14-sha256")
                .unwrap();
            session
                .method_pref(ssh2::MethodType::HostKey, "rsa-sha2-256")
                .unwrap();
            session.handshake().unwrap();
            session.userauth_password("test", "fixture-only").unwrap();
            session
        };
        let result =
            run_on_session(&connect(), "large-stderr", &CommandControl::default()).unwrap();
        assert_eq!(result.stdout, "stdout-after-stderr");
        assert_eq!(result.stderr.len(), 3 * 1024 * 1024);
        assert_eq!(result.exit_code, 0);
        let limited = CommandControl::new(Duration::from_secs(5), 64 * 1024);
        assert!(run_on_session(&connect(), "large-stderr", &limited)
            .unwrap_err()
            .contains("输出超过"));
        let timed = CommandControl::new(Duration::from_millis(100), 1024);
        assert!(run_on_session(&connect(), "stall", &timed)
            .unwrap_err()
            .contains("超时"));
        let cancelled = Arc::new(CommandControl::default());
        let session = connect();
        let cancellation = cancelled.clone();
        let worker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancellation.cancel();
        });
        assert!(run_on_session(&session, "stall", &cancelled)
            .unwrap_err()
            .contains("取消"));
        worker.join().unwrap();

        // Exercise real SFTP v3 wire behavior and replacement without unlinking the original.
        use std::{io::Write, path::Path};
        let session = connect();
        let sftp = session.sftp().unwrap();
        let original = Path::new("/original's file");
        let temp = Path::new("/temporary file");
        sftp.create(original).unwrap().write_all(b"old").unwrap();
        let original_snapshot = super::super::read_remote_snapshot(&sftp, original.to_str().unwrap()).unwrap();
        let original_revision = original_snapshot.revision;
        sftp.create(temp).unwrap().write_all(b"new").unwrap();
        super::super::rename_overwrite(&session, &sftp, temp, original).unwrap();
        assert!(session.is_blocking(), "command fallback must restore SFTP's blocking mode");
        let updated_snapshot = super::super::read_remote_snapshot(&sftp, original.to_str().unwrap()).unwrap();
        assert_eq!(updated_snapshot.bytes, b"new");
        let updated_revision = updated_snapshot.revision;
        assert_eq!(original_revision.size, updated_revision.size);
        assert_eq!(original_revision.modified, updated_revision.modified);
        assert!(super::super::ensure_remote_revision(&original_revision, &updated_revision).is_err());
        assert!(sftp.stat(temp).is_err());
    }
}
