#[path = "../tests/support/template_fixture_data.rs"]
mod template_fixture_data;

fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&template_fixture_data::produce()).unwrap()
    );
}
