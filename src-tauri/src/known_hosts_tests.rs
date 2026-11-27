use super::*;

struct KnownHostsFixture {
    root: PathBuf,
    path: PathBuf,
    session: Session,
}

impl KnownHostsFixture {
    fn new(content: &str) -> Self {
        let root = env::temp_dir().join(format!("sshstar-known-hosts-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("known_hosts");
        fs::write(&path, content).unwrap();
        Self {
            root,
            path,
            session: Session::new().unwrap(),
        }
    }

    fn verify(&self, host: &str, port: u16, key: &[u8]) -> Result<(), String> {
        verify_known_host_key(
            &self.session,
            host,
            port,
            key,
            HostKeyType::Ed25519,
            &self.path,
        )
    }

    fn stored(&self) -> ssh2::KnownHosts {
        let mut hosts = self.session.known_hosts().unwrap();
        hosts
            .read_file(&self.path, KnownHostFileKind::OpenSSH)
            .unwrap();
        hosts
    }
}

impl Drop for KnownHostsFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn host_line(host: &str, key: &[u8]) -> String {
    format!("{host} ssh-ed25519 {}\n", BASE64_STANDARD.encode(key))
}

fn hashed_host(host: &str) -> String {
    let salt = b"sshstar-test-salt-123";
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, salt);
    let digest = ring::hmac::sign(&key, host.as_bytes());
    format!(
        "|1|{}|{}",
        BASE64_STANDARD.encode(salt),
        BASE64_STANDARD.encode(digest)
    )
}

#[test]
fn known_hosts_automatically_replaces_mismatched_plain_and_hashed_keys() {
    for (host, port, stored_name) in [
        ("host.example", 22, "host.example"),
        ("host.example", 22, "[host.example]:22"),
        ("host.example", 2201, "[host.example]:2201"),
        ("::1", 2201, "[::1]:2201"),
    ] {
        for hashed in [false, true] {
            let name = if hashed {
                hashed_host(stored_name)
            } else {
                stored_name.to_string()
            };
            let other = host_line(&hashed_host("other.example"), b"old-key");
            let fixture = KnownHostsFixture::new(&(other + &host_line(&name, b"old-key")));
            assert!(matches!(
                fixture.stored().check_port(host, port, b"new-key"),
                CheckResult::Mismatch
            ));

            fixture.verify(host, port, b"new-key").unwrap();

            let hosts = fixture.stored();
            assert!(matches!(
                hosts.check_port(host, port, b"new-key"),
                CheckResult::Match
            ));
            assert!(matches!(
                hosts.check_port(host, port, b"old-key"),
                CheckResult::Mismatch
            ));
            assert!(matches!(
                hosts.check("other.example", b"old-key"),
                CheckResult::Match
            ));
            let saved = fs::read(&fixture.path).unwrap();
            fixture.verify(host, port, b"new-key").unwrap();
            assert_eq!(fs::read(&fixture.path).unwrap(), saved);
        }
    }
}

#[test]
fn known_hosts_cleanup_preserves_aliases_comments_and_other_ports() {
    let retained = "# keep comment\r\nalias.example ssh-ed25519 b2xk\r\n[host.example]:2202 ssh-ed25519 b2xk\r\n\r\n";
    let fixture = KnownHostsFixture::new(&format!(
        "# keep comment\r\nalias.example,[host.example]:2201 ssh-ed25519 b2xk\r\n[host.example]:2202 ssh-ed25519 b2xk\r\n{}\r\n",
        host_line("[host.example]:2201", b"another-old-key")
    ));

    assert!(remove_known_host_entries_at_path(&fixture.path, "host.example", 2201).unwrap());
    assert_eq!(fs::read_to_string(&fixture.path).unwrap(), retained);
    assert!(!remove_known_host_entries_at_path(&fixture.path, "host.example", 2201).unwrap());
}

#[test]
fn known_hosts_custom_port_recovery_preserves_default_port_key() {
    let fixture = KnownHostsFixture::new(
        &(host_line("host.example", b"default-key")
            + &host_line("[host.example]:2201", b"old-key")),
    );

    fixture.verify("host.example", 2201, b"new-key").unwrap();

    let hosts = fixture.stored();
    assert!(matches!(
        hosts.check("host.example", b"default-key"),
        CheckResult::Match
    ));
    assert!(matches!(
        hosts.check("[host.example]:2201", b"new-key"),
        CheckResult::Match
    ));
}

#[test]
fn known_hosts_records_first_key_without_replacing_other_port() {
    let fixture = KnownHostsFixture::new(&host_line("host.example", b"default-key"));
    fixture.verify("host.example", 2201, b"custom-key").unwrap();
    assert!(matches!(
        fixture.stored().check("host.example", b"default-key"),
        CheckResult::Match
    ));
    assert!(matches!(
        fixture.stored().check("[host.example]:2201", b"custom-key"),
        CheckResult::Match
    ));

    fs::remove_file(&fixture.path).unwrap();
    assert!(!remove_known_host_entries_at_path(&fixture.path, "host.example", 22).unwrap());
    fixture.verify("host.example", 22, b"first-key").unwrap();
    assert!(matches!(
        fixture.stored().check("host.example", b"first-key"),
        CheckResult::Match
    ));
}

#[test]
fn known_hosts_returns_file_errors_and_rejects_invalid_hashes() {
    let fixture = KnownHostsFixture::new("");
    fs::remove_file(&fixture.path).unwrap();
    fs::create_dir(&fixture.path).unwrap();
    assert!(fixture.verify("host.example", 22, b"new-key").is_err());
    assert!(remove_known_host_entries_at_path(&fixture.path, "host.example", 22).is_err());
    for line in ["|1|invalid|invalid", "|1|c2FsdA==|", "|2|c2FsdA==|aGFzaA=="] {
        assert!(!known_host_line_matches(line, "host.example", 22));
    }
}
