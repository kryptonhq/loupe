//! Server-side printing: the columns `kubectl get` shows, for any kind.
//!
//! The obvious way to list Services, Deployments, Ingresses and the rest
//! is to write a summary struct per kind — which is a summary struct per
//! kind forever, and still leaves every CRD with nothing but a name and
//! an age.
//!
//! Kubernetes already solved this. Ask for `Accept: application/json;
//! as=Table`, and the API server returns the same column definitions and
//! cells kubectl prints, computed by the same code. Built-in kinds get
//! their familiar columns; a CRD gets whatever `additionalPrinterColumns`
//! its author defined. One implementation, and it stays right as the
//! cluster grows kinds this build has never heard of.
//!
//! What we do not get is control over the columns, which is the whole
//! point: matching kubectl is the feature.

use kube::api::ListParams;
use kube::core::{Request, Resource};
use kube::discovery::Scope;
use serde::{Deserialize, Serialize};

use crate::cluster::discovery::{resolve, GvkRef};
use crate::cluster::Session;
use crate::error::{AppError, Result};

/// The content type that asks for server-side printing.
const TABLE_ACCEPT: &str = "application/json;as=Table;v=v1;g=meta.k8s.io";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableColumn {
    pub name: String,
    /// 0 for columns kubectl shows by default; higher for the ones it
    /// keeps back for `-o wide`. Passed through so the UI can make the
    /// same distinction rather than drowning a narrow pane in Selector
    /// and Images columns.
    pub priority: i32,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRow {
    pub name: String,
    pub namespace: Option<String>,
    /// One per column, already rendered to text.
    pub cells: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTable {
    pub columns: Vec<TableColumn>,
    pub rows: Vec<TableRow>,
    /// Whether the objects listed carry a namespace, so the UI knows
    /// whether a namespace filter means anything here.
    pub namespaced: bool,
}

// The wire shapes. Deliberately permissive: an aggregated API server can
// return a Table that is missing pieces, and a listing should degrade
// rather than fail.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireTable {
    #[serde(default)]
    column_definitions: Vec<WireColumn>,
    #[serde(default)]
    rows: Vec<WireRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireColumn {
    name: String,
    #[serde(default)]
    priority: i32,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRow {
    #[serde(default)]
    cells: Vec<serde_json::Value>,
    /// PartialObjectMetadata for the row. Where the name and namespace
    /// come from — the Name *cell* is display text and can be decorated,
    /// so it is not safe to route back into an API request.
    #[serde(default)]
    object: Option<WireObject>,
}

#[derive(Debug, Deserialize)]
struct WireObject {
    #[serde(default)]
    metadata: WireMeta,
}

#[derive(Debug, Default, Deserialize)]
struct WireMeta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    namespace: Option<String>,
}

/// Renders a cell to the text kubectl would print.
///
/// Cells are typed JSON — Deployments send integers for Up-to-date,
/// Ingresses can send null for an address that has not been assigned —
/// and the frontend should not have to care which.
fn cell_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => "<none>".into(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn convert(table: WireTable, namespaced: bool) -> ResourceTable {
    let width = table.column_definitions.len();

    let rows = table
        .rows
        .into_iter()
        .filter_map(|row| {
            let meta = row.object.map(|o| o.metadata).unwrap_or_default();
            // A row we cannot name is a row nothing can be opened from.
            let name = meta.name?;

            let mut cells: Vec<String> = row.cells.iter().map(cell_text).collect();
            // Pad or trim to the column count: a mismatch would slide
            // every value one column to the left, which reads as real
            // data and is worse than a blank.
            cells.resize(width, String::new());

            Some(TableRow {
                name,
                namespace: meta.namespace,
                cells,
            })
        })
        .collect();

    ResourceTable {
        columns: table
            .column_definitions
            .into_iter()
            .map(|c| TableColumn {
                name: c.name,
                priority: c.priority,
                description: c.description.filter(|d| !d.is_empty()),
            })
            .collect(),
        rows,
        namespaced,
    }
}

pub async fn list_table(
    session: &Session,
    gvk: GvkRef,
    namespace: Option<String>,
) -> Result<ResourceTable> {
    let client = session.client().await?;
    let (resource, caps) = resolve(session, &gvk).await?;

    let namespaced = matches!(caps.scope, Scope::Namespaced);
    // The resource's own scope wins: asking for a namespace on a
    // cluster-scoped kind builds a URL the API server does not serve.
    let scope = match (namespaced, namespace.as_deref()) {
        (true, Some(ns)) if !ns.is_empty() => Some(ns),
        _ => None,
    };

    let url = <kube::api::DynamicObject as Resource>::url_path(&resource, scope);
    let request = Request::new(url)
        .list(&ListParams::default())
        .map_err(|e| AppError::Kube(format!("build request: {e}")))?;

    // Same request kube would send, with the Accept header swapped for
    // the one that asks the server to print.
    let (mut parts, body) = request.into_parts();
    parts.headers.insert(
        http::header::ACCEPT,
        http::HeaderValue::from_static(TABLE_ACCEPT),
    );

    let table: WireTable = client
        .request(http::Request::from_parts(parts, body))
        .await?;

    Ok(convert(table, namespaced))
}

/// Names a kind inline. The frontend sends a `GvkRef` of its own, so
/// this exists for the tests.
#[cfg(test)]
pub fn gvk(group: &str, version: &str, kind: &str) -> GvkRef {
    GvkRef {
        group: group.to_string(),
        version: version.to_string(),
        kind: kind.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wire(value: serde_json::Value) -> WireTable {
        serde_json::from_value(value).expect("parse table")
    }

    #[test]
    fn reads_the_columns_and_cells_the_server_printed() {
        let table = convert(
            wire(json!({
                "columnDefinitions": [
                    {"name": "Name", "priority": 0},
                    {"name": "Type", "priority": 0},
                    {"name": "Selector", "priority": 1, "description": "label selector"}
                ],
                "rows": [{
                    "cells": ["kube-dns", "ClusterIP", "k8s-app=kube-dns"],
                    "object": {"metadata": {"name": "kube-dns", "namespace": "kube-system"}}
                }]
            })),
            true,
        );

        assert_eq!(
            table
                .columns
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Name", "Type", "Selector"]
        );
        // Priority marks the columns kubectl holds back for -o wide.
        assert_eq!(table.columns[2].priority, 1);
        assert_eq!(
            table.columns[2].description.as_deref(),
            Some("label selector")
        );
        assert_eq!(
            table.rows[0].cells,
            vec!["kube-dns", "ClusterIP", "k8s-app=kube-dns"]
        );
        assert_eq!(table.rows[0].namespace.as_deref(), Some("kube-system"));
    }

    #[test]
    fn renders_non_string_cells_the_way_kubectl_prints_them() {
        // Deployments send integers for Up-to-date and Available; an
        // Ingress with no address assigned sends null.
        let table = convert(
            wire(json!({
                "columnDefinitions": [{"name": "Ready"}, {"name": "Up-to-date"}, {"name": "Address"}],
                "rows": [{
                    "cells": ["1/1", 1, null],
                    "object": {"metadata": {"name": "gateway"}}
                }]
            })),
            true,
        );
        assert_eq!(table.rows[0].cells, vec!["1/1", "1", "<none>"]);
    }

    #[test]
    fn identity_comes_from_the_object_not_the_name_cell() {
        // kubectl decorates the name cell — "pod/foo", or a trailing
        // marker on a terminating object. Routing that back into a URL
        // would 404, so the metadata is the only safe source.
        let table = convert(
            wire(json!({
                "columnDefinitions": [{"name": "Name"}],
                "rows": [{
                    "cells": ["service/kube-dns"],
                    "object": {"metadata": {"name": "kube-dns", "namespace": "kube-system"}}
                }]
            })),
            true,
        );
        assert_eq!(table.rows[0].name, "kube-dns");
    }

    #[test]
    fn a_row_with_no_metadata_is_dropped() {
        // Nothing can be opened from it, and a row that does nothing on
        // click reads as a broken table.
        let table = convert(
            wire(json!({
                "columnDefinitions": [{"name": "Name"}],
                "rows": [
                    {"cells": ["nameless"]},
                    {"cells": ["real"], "object": {"metadata": {"name": "real"}}}
                ]
            })),
            true,
        );
        assert_eq!(table.rows.len(), 1);
        assert_eq!(table.rows[0].name, "real");
    }

    #[test]
    fn cells_are_squared_off_against_the_column_count() {
        // A short row would otherwise leave the last column reading a
        // value from nowhere; a long one would hide a value entirely.
        let table = convert(
            wire(json!({
                "columnDefinitions": [{"name": "A"}, {"name": "B"}, {"name": "C"}],
                "rows": [
                    {"cells": ["one"], "object": {"metadata": {"name": "short"}}},
                    {"cells": ["1", "2", "3", "4"], "object": {"metadata": {"name": "long"}}}
                ]
            })),
            false,
        );
        assert_eq!(table.rows[0].cells, vec!["one", "", ""]);
        assert_eq!(table.rows[1].cells, vec!["1", "2", "3"]);
    }

    #[test]
    fn an_empty_table_is_not_an_error() {
        // A kind with nothing in it still has columns to show.
        let table = convert(wire(json!({"columnDefinitions": [{"name": "Name"}]})), true);
        assert!(table.rows.is_empty());
        assert_eq!(table.columns.len(), 1);
    }

    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn prints_the_same_columns_kubectl_would() {
        let session = crate::cluster::live::session().await;

        let services = list_table(&session, gvk("", "v1", "Service"), None)
            .await
            .expect("list services");
        let names: Vec<&str> = services.columns.iter().map(|c| c.name.as_str()).collect();
        println!("Service columns: {names:?}");
        // These are kubectl's, and they come from the API server rather
        // than from anything in this repo.
        for expected in ["Name", "Type", "Cluster-IP", "Port(s)", "Age"] {
            assert!(names.contains(&expected), "missing {expected} in {names:?}");
        }
        assert!(services.namespaced);
        assert!(
            services
                .rows
                .iter()
                .all(|r| r.cells.len() == services.columns.len()),
            "every row should be as wide as the header"
        );

        let deployments = list_table(&session, gvk("apps", "v1", "Deployment"), None)
            .await
            .expect("list deployments");
        println!(
            "Deployment columns: {:?}",
            deployments
                .columns
                .iter()
                .map(|c| &c.name)
                .collect::<Vec<_>>()
        );
        // Containers/Images/Selector are wide-only; the pane hides them
        // by default and would show a wall of text if priority were lost.
        assert!(
            deployments.columns.iter().any(|c| c.priority > 0),
            "Deployment has wide-only columns"
        );

        let nodes = list_table(&session, gvk("", "v1", "Node"), None)
            .await
            .expect("list nodes");
        assert!(!nodes.namespaced, "nodes are cluster-scoped");
        assert!(nodes.rows.iter().all(|r| r.namespace.is_none()));
    }

    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn a_crd_gets_the_columns_its_author_defined() {
        let session = crate::cluster::live::session().await;

        let resources = crate::cluster::discovery::list_api_resources(&session)
            .await
            .expect("discover");
        let Some(target) = resources.iter().find(|r| r.custom) else {
            println!("no custom resources installed");
            return;
        };

        let table = list_table(
            &session,
            gvk(&target.group, &target.version, &target.kind),
            None,
        )
        .await
        .unwrap_or_else(|e| panic!("list {}: {e}", target.kind));

        println!(
            "{} columns: {:?}",
            target.kind,
            table.columns.iter().map(|c| &c.name).collect::<Vec<_>>()
        );
        // Even a CRD with no additionalPrinterColumns gets Name and Age
        // from the server's default printer.
        assert!(table.columns.iter().any(|c| c.name == "Name"));
    }
}
