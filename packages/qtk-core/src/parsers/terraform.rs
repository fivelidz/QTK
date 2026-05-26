//! Terraform plan compressor.
//!
//! Raw form (verbose, often 50-500+ lines for any non-trivial change):
//!
//! ```text
//! Terraform used the selected providers to generate the following execution
//! plan. Resource actions are indicated with the following symbols:
//!   + create
//!   ~ update in-place
//!   - destroy
//!
//! Terraform will perform the following actions:
//!
//!   # aws_instance.web will be updated in-place
//!   ~ resource "aws_instance" "web" {
//!         ami                          = "ami-0c55b159cbfafe1f0"
//!       ~ instance_type                = "t3.micro" -> "t3.small"
//!         tags                         = {
//!             "Name" = "web-server"
//!         }
//!         # (35 unchanged attributes hidden)
//!     }
//!
//!   # aws_security_group.web will be created
//!   + resource "aws_security_group" "web" {
//!       + arn                    = (known after apply)
//!       + description            = "Web security group"
//!       ...
//!     }
//!
//! Plan: 1 to add, 1 to change, 0 to destroy.
//! ```
//!
//! Compressed form (one line per resource + the plan summary):
//!
//! ```text
//! Plan: 1 add, 1 change, 0 destroy
//!   + aws_security_group.web
//!   ~ aws_instance.web (instance_type)
//! ```
//!
//! Strategy: regex-scan for the resource-header lines and the summary line.
//! For `update in-place` resources, extract just the field names that
//! actually change (lines starting with `~ <name>`).

use regex::Regex;
use std::sync::OnceLock;

static RESOURCE_HEADER: OnceLock<Regex> = OnceLock::new();
static CHANGED_ATTR: OnceLock<Regex> = OnceLock::new();
static PLAN_SUMMARY: OnceLock<Regex> = OnceLock::new();
static NO_CHANGES: OnceLock<Regex> = OnceLock::new();

fn resource_header() -> &'static Regex {
    RESOURCE_HEADER.get_or_init(|| {
        // Matches lines like:
        //   # aws_instance.web will be updated in-place
        //   # module.x.aws_subnet.private[0] will be created
        //   # aws_eip.nat will be destroyed
        Regex::new(r"^\s*#\s+(?P<addr>\S+)\s+will be (?P<action>created|updated in-place|destroyed|replaced|read during apply)")
            .expect("static regex")
    })
}

fn changed_attr() -> &'static Regex {
    CHANGED_ATTR.get_or_init(|| {
        // Matches lines like:
        //   ~ instance_type                = "t3.micro" -> "t3.small"
        //   + ingress {  (also opens a block, we accept it)
        // We only care about the field name for the summary.
        Regex::new(r"^\s+[~+-]\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*=").expect("static regex")
    })
}

fn plan_summary() -> &'static Regex {
    PLAN_SUMMARY.get_or_init(|| {
        Regex::new(r"^Plan:\s+(?P<add>\d+)\s+to add,\s+(?P<change>\d+)\s+to change,\s+(?P<destroy>\d+)\s+to destroy")
            .expect("static regex")
    })
}

fn no_changes() -> &'static Regex {
    NO_CHANGES.get_or_init(|| {
        Regex::new(r"(?i)no changes\.\s*(your infrastructure matches|infrastructure matches)")
            .expect("static regex")
    })
}

#[must_use]
pub fn compress(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    // Quick gate: only fire if it looks like terraform output
    if !input.contains("Terraform")
        && !input.contains("Plan:")
        && !input.contains("resource ")
    {
        return input.to_string();
    }

    // "No changes" shortcut
    if no_changes().is_match(input) {
        return "Plan: no changes (infrastructure matches configuration)".to_string();
    }

    let header_re = resource_header();
    let attr_re = changed_attr();
    let plan_re = plan_summary();

    #[derive(Debug)]
    struct Resource {
        action: String,
        addr: String,
        changed_fields: Vec<String>,
    }

    let mut resources: Vec<Resource> = Vec::new();
    let mut cur: Option<Resource> = None;
    let mut summary: Option<String> = None;

    for line in input.lines() {
        if let Some(caps) = header_re.captures(line) {
            if let Some(r) = cur.take() {
                resources.push(r);
            }
            cur = Some(Resource {
                action: caps["action"].to_string(),
                addr: caps["addr"].to_string(),
                changed_fields: Vec::new(),
            });
            continue;
        }
        if let Some(caps) = plan_re.captures(line) {
            summary = Some(format!(
                "Plan: {} add, {} change, {} destroy",
                &caps["add"], &caps["change"], &caps["destroy"]
            ));
            continue;
        }
        if let Some(r) = cur.as_mut() {
            // Only track field changes for "updated in-place" — for create
            // and destroy, listing all fields is noise.
            if r.action == "updated in-place" {
                if let Some(c) = attr_re.captures(line) {
                    let name = c["name"].to_string();
                    if !r.changed_fields.contains(&name) {
                        r.changed_fields.push(name);
                    }
                }
            }
        }
    }
    if let Some(r) = cur.take() {
        resources.push(r);
    }

    // Build output
    let mut out = String::with_capacity(256);
    if let Some(s) = summary {
        out.push_str(&s);
        out.push('\n');
    } else if resources.is_empty() {
        // Nothing useful parsed — return raw rather than emit a misleading summary
        return input.to_string();
    }

    const MAX_RES: usize = 30;
    for (i, r) in resources.iter().enumerate() {
        if i >= MAX_RES {
            out.push_str(&format!(
                "  ... +{} more resource(s)\n",
                resources.len() - MAX_RES
            ));
            break;
        }
        let symbol = match r.action.as_str() {
            "created" => "+",
            "destroyed" => "-",
            "replaced" => "+/-",
            "read during apply" => "?",
            "updated in-place" => "~",
            _ => "?",
        };
        out.push_str("  ");
        out.push_str(symbol);
        out.push(' ');
        out.push_str(&r.addr);
        if r.action == "updated in-place" && !r.changed_fields.is_empty() {
            const MAX_FIELDS: usize = 6;
            let shown: Vec<&str> = r
                .changed_fields
                .iter()
                .take(MAX_FIELDS)
                .map(String::as_str)
                .collect();
            let suffix = if r.changed_fields.len() > MAX_FIELDS {
                format!(", +{} more", r.changed_fields.len() - MAX_FIELDS)
            } else {
                String::new()
            };
            out.push_str(&format!(" ({}{})", shown.join(", "), suffix));
        }
        out.push('\n');
    }

    if out.ends_with('\n') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input() {
        assert_eq!(compress(""), "");
    }

    #[test]
    fn no_terraform_marker_passes_through() {
        let input = "this is just random text without the magic words";
        assert_eq!(compress(input), input);
    }

    #[test]
    fn no_changes_shortcut() {
        let input = "Terraform used the selected providers.\nNo changes. Your infrastructure matches the configuration.\n";
        let out = compress(input);
        assert!(out.contains("no changes"));
        assert!(out.len() < input.len());
    }

    #[test]
    fn parses_create_destroy_update() {
        let input = r#"Terraform will perform the following actions:

  # aws_instance.web will be updated in-place
  ~ resource "aws_instance" "web" {
        ami                          = "ami-0c55"
      ~ instance_type                = "t3.micro" -> "t3.small"
      ~ tags                         = {
            "Name" = "web"
        }
    }

  # aws_security_group.api will be created
  + resource "aws_security_group" "api" {
      + name = "api-sg"
    }

  # aws_eip.old will be destroyed
  - resource "aws_eip" "old" {}

Plan: 1 to add, 1 to change, 1 to destroy.
"#;
        let out = compress(input);
        assert!(out.contains("Plan: 1 add, 1 change, 1 destroy"));
        assert!(out.contains("~ aws_instance.web (instance_type, tags)"));
        assert!(out.contains("+ aws_security_group.api"));
        assert!(out.contains("- aws_eip.old"));
        assert!(out.len() < input.len() / 2);
    }

    #[test]
    fn caps_long_field_lists() {
        let mut input = String::from(
            "Terraform will perform the following actions:\n\n  # x.y will be updated in-place\n  ~ resource \"x\" \"y\" {\n",
        );
        for i in 0..20 {
            input.push_str(&format!("      ~ field_{i:02} = \"a\" -> \"b\"\n"));
        }
        input.push_str("    }\n\nPlan: 0 to add, 1 to change, 0 to destroy.\n");
        let out = compress(&input);
        assert!(out.contains("+14 more")); // 20 fields - 6 shown = 14
        assert!(out.len() < input.len());
    }
}
