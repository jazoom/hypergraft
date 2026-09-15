use std::{fs, path::PathBuf, process::Command};

struct Consumer(PathBuf);

impl Drop for Consumer {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Consumer {
    fn run(&self, arguments: &[&str]) -> std::process::Output {
        Command::new(env!("CARGO"))
            .args(arguments)
            .current_dir(&self.0)
            .env("CARGO_TARGET_DIR", self.0.join("target"))
            .output()
            .unwrap()
    }

    fn output(&self) -> String {
        let output = self.run(&["run", "--offline", "--quiet"]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
}

#[test]
fn external_sources_rebuild_through_a_renamed_dependency() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let consumer = Consumer(std::env::temp_dir().join(format!(
        "hypergraft-rebuild-{}-{unique}",
        std::process::id()
    )));
    fs::create_dir_all(consumer.0.join("src")).unwrap();
    fs::create_dir_all(consumer.0.join("templates")).unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    fs::write(
        consumer.0.join("Cargo.toml"),
        format!(
            r#"
[package]
name = "template-rebuild-consumer"
version = "0.0.0"
edition = "2024"
[workspace]
[dependencies]
renamed = {{ package = "hypergraft", path = {root:?} }}
"#
        ),
    )
    .unwrap();
    fs::write(
        consumer.0.join("src/main.rs"),
        r#"
use renamed::GraftTemplate;
#[derive(GraftTemplate)]
#[graft(path = "templates/child.graft.html")]
struct Child;
#[derive(GraftTemplate)]
#[graft(path = "templates/direct.graft.html")]
struct Direct<'a, T: GraftTemplate> { child: &'a T }
fn main() { print!("{}", Direct { child: &Child }.render().unwrap()); }
"#,
    )
    .unwrap();
    let direct = consumer.0.join("templates/direct.graft.html");
    let child = consumer.0.join("templates/child.graft.html");
    fs::write(&direct, "<main>{% render self.child %}</main>").unwrap();
    fs::write(&child, "<b>first</b>").unwrap();
    // The outer Cargo build supplies the dependency cache. All nested builds stay offline.
    assert_eq!(consumer.output(), "<main><b>first</b></main>");
    fs::write(&direct, "<section>{% render self.child %}</section>").unwrap();
    assert_eq!(consumer.output(), "<section><b>first</b></section>");
    fs::write(&child, "<b>changed child</b>").unwrap();
    assert_eq!(consumer.output(), "<section><b>changed child</b></section>");

    // Strings cannot cross the typed HTML boundary.
    fs::write(&direct, "{% render \"untrusted\" %}").unwrap();
    let rejected = consumer.run(&["check", "--offline", "--quiet"]);
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("GraftTemplate"));
}
