use hypergraft::GraftTemplate;
use hypergraft::PatchSet;
use serde_json::json;
use std::{hint::black_box, time::Instant};

#[derive(GraftTemplate)]
#[graft(path = "benchmarks/templates/list.graft.html")]
struct List {
    rows: Vec<usize>,
    keyed: bool,
}

#[derive(GraftTemplate)]
#[graft(path = "benchmarks/templates/fragment.graft.html")]
struct Fragment {
    rows: Vec<usize>,
}

fn measure<T: GraftTemplate>(name: &str, template: &T, append: bool) -> serde_json::Value {
    let mut render = Vec::new();
    let mut encode = Vec::new();
    let mut html_bytes = 0;
    let mut envelope_bytes = 0;
    for index in 0..120 {
        let start = Instant::now();
        let html = GraftTemplate::render(black_box(template)).unwrap();
        let render_ns = start.elapsed().as_nanos() as u64;
        html_bytes = black_box(html).len();
        // Patch construction renders again outside the isolated encoding interval.
        let mut patches = PatchSet::new();
        if append {
            patches.append("target", template).unwrap();
        } else {
            patches.children("target", template).unwrap();
        }
        let start = Instant::now();
        let envelope = black_box(patches).encode_live().unwrap();
        let encode_ns = start.elapsed().as_nanos() as u64;
        envelope_bytes = black_box(envelope).len();
        if index >= 20 {
            render.push(render_ns);
            encode.push(encode_ns);
        }
    }
    json!({"workload": name, "render_ns": render, "encode_ns": encode,
        "html_bytes": html_bytes, "envelope_bytes": envelope_bytes})
}

fn main() {
    let mut results = Vec::new();
    for keyed in [true, false] {
        for operation in ["unchanged", "insertion", "reorder"] {
            let mut rows: Vec<_> = (0..1000).collect();
            if operation == "insertion" {
                rows.insert(0, 1000);
            } else if operation == "reorder" {
                rows.reverse();
            }
            results.push(measure(
                &format!("{}-{operation}", if keyed { "id" } else { "generated" }),
                &List { rows, keyed },
                false,
            ));
        }
    }
    results.push(measure(
        "small-large-document",
        &List {
            rows: vec![0],
            keyed: true,
        },
        false,
    ));
    for batch in 0..10 {
        results.push(measure(
            &format!("append-{batch}"),
            &Fragment {
                rows: (batch * 100..(batch + 1) * 100).collect(),
            }
            .scoped(batch),
            true,
        ));
    }
    println!(
        "{}",
        json!({"engine": "hypergraft owned compiler 0.0.1", "warmup": 20, "samples": 100, "results": results})
    );
}
