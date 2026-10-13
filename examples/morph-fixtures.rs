use askama::Template;
use serde_json::{Value, json};

#[derive(Template)]
#[template(
    source = "{% for id in rows %}<article{% if keyed %} id=\"row-{{ id }}\"{% endif %}><span>Row {{ id }}</span></article>{% endfor %}",
    ext = "html"
)]
struct Rows<'a> {
    rows: &'a [usize],
    keyed: bool,
}

#[derive(Template)]
#[template(
    source = "{% for id in rows %}<label><input id=\"input-{{ id }}\" name=\"item-{{ id }}\" value=\"Row {{ id }}\"><textarea id=\"text-{{ id }}\" name=\"text-{{ id }}\">Row {{ id }}</textarea></label>{% endfor %}",
    ext = "html"
)]
struct Controls<'a> {
    rows: &'a [usize],
}

fn workload(name: &str, initial: &str, incoming: &str) -> Value {
    json!({ "name": name, "initial": initial, "incoming": incoming, "operation": "children" })
}

fn main() {
    let rows: Vec<_> = (0..1_000).collect();
    let inserted: Vec<_> = (1_000..1_100).chain(0..1_000).collect();
    let deleted: Vec<_> = (0..1_000).filter(|id| id % 5 != 0).collect();
    let reversed: Vec<_> = (0..1_000).rev().collect();
    let rotated: Vec<_> = (999..1_000).chain(0..999).collect();
    let shuffled: Vec<_> = (0..1_000).step_by(2).chain((1..1_000).step_by(2)).collect();
    let replaced: Vec<_> = (1_000..2_000).collect();
    let mut workloads = Vec::new();
    for keyed in [true, false] {
        let prefix = if keyed { "keyed" } else { "unkeyed" };
        let render = |rows| Rows { rows, keyed }.render().unwrap();
        let initial = render(&rows);
        for (name, next) in [
            ("unchanged", &rows),
            ("insert", &inserted),
            ("delete", &deleted),
            ("reverse", &reversed),
            ("rotate", &rotated),
            ("shuffle", &shuffled),
            ("replace", &replaced),
        ] {
            workloads.push(workload(
                &format!("{prefix}-{name}"),
                &initial,
                &render(next),
            ));
        }
    }
    let controls = Controls { rows: &rows[..200] }.render().unwrap();
    let mut dirty = workload("dirty-controls", &controls, &controls);
    dirty["dirty"] = json!(true);
    dirty["ownership"] = json!(true);
    workloads.push(dirty);
    let mut small = workload("small-target", "<p>Old</p>", "<p>New</p>");
    small["surrounding"] = json!(
        Rows {
            rows: &rows,
            keyed: true
        }
        .render()
        .unwrap()
    );
    workloads.push(small);
    let mut append = workload(
        "append",
        &Rows {
            rows: &rows,
            keyed: true,
        }
        .render()
        .unwrap(),
        &Rows {
            rows: &inserted[..100],
            keyed: true,
        }
        .render()
        .unwrap(),
    );
    append["operation"] = json!("append");
    workloads.push(append);
    println!("{}", json!(workloads));
}
