use hypergraft::{GraftTemplate, PatchSet};
use serde_json::{Value, json};

pub struct Row {
    pub id: u32,
    pub label: &'static str,
    pub active: bool,
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/blocks.graft.html")]
pub struct Page<'a> {
    pub heading: &'a str,
    pub rows: &'a [Row],
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/blocks.graft.html", block = "results")]
pub struct Results<'a> {
    pub rows: &'a [Row],
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/blocks.graft.html", block = "row_contents")]
pub struct RowContents<'a> {
    pub row: &'a Row,
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/blocks.graft.html", block = "status")]
pub struct Status<'a> {
    pub row: &'a Row,
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/block-composition.graft.html")]
struct Siblings<'a> {
    fragment: Status<'a>,
}

pub fn produce() -> Value {
    let rows = [
        Row {
            id: 1,
            label: "One & only",
            active: true,
        },
        Row {
            id: 2,
            label: "Two",
            active: false,
        },
    ];
    let page = Page {
        heading: "Tasks",
        rows: &rows,
    }
    .render()
    .unwrap();
    let results = Results { rows: &rows }.render().unwrap();
    let row = RowContents { row: &rows[0] }.render().unwrap();
    let status = Status { row: &rows[0] }.render().unwrap();
    let siblings = Siblings {
        fragment: Status { row: &rows[0] },
    }
    .render()
    .unwrap();
    let mut append = Vec::new();
    for instance in [1, 2] {
        let fragment = Status { row: &rows[0] }.scoped(instance);
        let mut patches = PatchSet::new();
        patches.append("append", &fragment).unwrap();
        append.push(json!({ "html": fragment.render().unwrap(), "envelope": patches.encode_live().unwrap() }));
    }
    let mut patch = PatchSet::new();
    patch
        .children("row-1", &RowContents { row: &rows[0] })
        .unwrap();
    let reversed = [rows[1].id, rows[0].id];
    let reordered_rows: Vec<_> = reversed
        .iter()
        .map(|id| {
            let row = rows.iter().find(|row| row.id == *id).unwrap();
            Row {
                id: row.id,
                label: row.label,
                active: row.active,
            }
        })
        .collect();
    let reordered = Results {
        rows: &reordered_rows,
    }
    .render()
    .unwrap();
    let alternative = Status { row: &rows[1] }.render().unwrap();
    json!({ "page": page, "results": results, "row": row, "status": status,
        "rowPatch": patch.encode_live().unwrap(), "reordered": reordered,
        "alternative": alternative, "siblings": siblings, "append": append })
}
