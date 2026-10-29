#!/usr/bin/env python3
"""Validate the bundled OpenAPI contract without installing dependencies.

Checks actual router method/path/handler coverage, DTO field/required/unknown
field rules, reference resolution, OAS structure and examples against the JSON
Schema keywords used here. This deliberately is not advertised as a complete
implementation of the OpenAPI or JSON Schema standards. No network calls.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
MUTATIONS = METHODS - {"get", "head", "options"}


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(path.read_text(), object_pairs_hook=unique)


def resolve(document, value):
    while isinstance(value, dict) and "$ref" in value:
        reference = value["$ref"]
        if not reference.startswith("#/"):
            raise ValueError(f"External reference is not self-contained: {reference}")
        target = document
        for part in reference[2:].split("/"):
            target = target[part.replace("~1", "/").replace("~0", "~")]
        value = target
    return value


def walk(value, location="$", schemas_only=False):
    if isinstance(value, dict):
        yield location, value
        for key, child in value.items():
            yield from walk(child, location + "/" + key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, location + "/" + str(index))


def matches_type(value, kind):
    return {
        "null": lambda: value is None,
        "object": lambda: isinstance(value, dict),
        "array": lambda: isinstance(value, list),
        "string": lambda: isinstance(value, str),
        "integer": lambda: isinstance(value, int) and not isinstance(value, bool),
        "number": lambda: isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": lambda: isinstance(value, bool),
    }[kind]()


def validate_value(document, value, schema, location="$", depth=0):
    if depth > 80:
        raise ValueError("Schema recursion limit exceeded")
    if schema is True:
        return
    if schema is False:
        raise ValueError(location + ": forbidden by schema")
    if "$ref" in schema:
        validate_value(document, value, resolve(document, schema), location, depth + 1)
        schema = {key: item for key, item in schema.items() if key != "$ref"}
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(matches_type(value, kind) for kind in types):
            raise ValueError(f"{location}: expected {types}, got {type(value).__name__}")
    if "const" in schema and (value != schema["const"] or isinstance(value, bool) != isinstance(schema["const"], bool)):
        raise ValueError(f"{location}: incorrect const")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{location}: not in enum")
    for branch in schema.get("allOf", []):
        validate_value(document, value, branch, location, depth + 1)
    for keyword in ["anyOf", "oneOf"]:
        if keyword in schema:
            count = 0
            for branch in schema[keyword]:
                try:
                    validate_value(document, value, branch, location, depth + 1)
                    count += 1
                except ValueError:
                    pass
            if count < 1 or keyword == "oneOf" and count != 1:
                raise ValueError(f"{location}: {keyword} matched {count} branches")
    if "not" in schema:
        try:
            validate_value(document, value, schema["not"], location, depth + 1)
        except ValueError:
            pass
        else:
            raise ValueError(f"{location}: matched forbidden schema")
    if "if" in schema:
        try:
            validate_value(document, value, schema["if"], location, depth + 1)
            branch = "then"
        except ValueError:
            branch = "else"
        if branch in schema:
            validate_value(document, value, schema[branch], location, depth + 1)
    if isinstance(value, dict):
        if not set(schema.get("required", [])).issubset(value):
            raise ValueError(f"{location}: missing {set(schema['required']) - set(value)}")
        properties = schema.get("properties", {})
        for key, item in value.items():
            if key in properties:
                validate_value(document, item, properties[key], location + "/" + key, depth + 1)
            elif schema.get("additionalProperties", True) is False:
                raise ValueError(f"{location}: unknown field {key}")
            elif isinstance(schema.get("additionalProperties"), dict):
                validate_value(document, item, schema["additionalProperties"], location + "/" + key, depth + 1)
    if isinstance(value, list):
        for name, comparator in [("minItems", lambda a, b: a >= b), ("maxItems", lambda a, b: a <= b)]:
            if name in schema and not comparator(len(value), schema[name]):
                raise ValueError(f"{location}: {name} violated")
        for index, item in enumerate(value):
            validate_value(document, item, schema.get("items", {}), f"{location}/{index}", depth + 1)
    if isinstance(value, str):
        for key, length, comparator in [
            ("minLength", len(value), lambda a, b: a >= b),
            ("maxLength", len(value), lambda a, b: a <= b),
            ("x-max-utf8-bytes", len(value.encode()), lambda a, b: a <= b),
            ("x-min-utf8-bytes", len(value.encode()), lambda a, b: a >= b),
        ]:
            if key in schema and not comparator(length, schema[key]):
                raise ValueError(f"{location}: {key} violated")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            raise ValueError(f"{location}: pattern mismatch")
        if schema.get("format") == "date-time":
            parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError(f"{location}: timestamp has no offset")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        for name, comparator in [("minimum", lambda a, b: a >= b), ("maximum", lambda a, b: a <= b)]:
            if name in schema and not comparator(value, schema[name]):
                raise ValueError(f"{location}: {name} violated")


def balanced_end(source, start, opening="(", closing=")"):
    depth, quoted, escaped = 0, False, False
    for index in range(start, len(source)):
        char = source[index]
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return index
    raise ValueError("Unbalanced Rust router expression")


def actual_routes(source, source_path="src/api.rs"):
    declaration = re.search(r'pub(?:\(crate\))?\s+fn\s+router\(', source)
    if not declaration:
        raise ValueError(f"Router function missing in {source_path}")
    start = declaration.start()
    brace = source.index("{", start)
    router = source[start:balanced_end(source, brace, "{", "}") + 1]
    if source_path == "src/api.rs" and '.nest("/api/v1", api)' not in router:
        raise ValueError("Router API prefix changed; update the contract/validator deliberately")
    output = {}
    for match in re.finditer(r'\.route\(\s*"([^"]+)"\s*,', router):
        path = match.group(1)
        end = balanced_end(router, router.index("(", match.start()))
        expression = router[match.end():end]
        full = path if path.startswith("/health/") else "/api/v1" + path
        declarations = re.findall(r'\b(get|post|patch|delete|put|head|options|trace)\(\s*([\w:]+)\s*\)', expression)
        if not declarations:
            raise ValueError(f"Cannot parse registered handler: {path}")
        for method, handler in declarations:
            key = (full, method)
            if key in output:
                raise ValueError(f"Duplicate registered route: {key}")
            parts = handler.split("::")
            handler_path = source_path if len(parts) == 1 else (Path(source_path).with_suffix("") / Path(*parts[:-1])).as_posix() + ".rs"
            output[key] = handler_path + "::" + parts[-1]
    for module in re.findall(r'\.merge\(crate::([\w:]+)::router\(\)\)', router):
        module_path = "src/" + module.replace("::", "/") + ".rs"
        child_routes = actual_routes((ROOT / module_path).read_text(), module_path)
        if set(output) & set(child_routes):
            raise ValueError(f"Merged router duplicates paths: {module_path}")
        output.update(child_routes)
    return output


def dto_checks(document):
    checks = 0
    groups = {
        "src/api.rs": {"LoginInput": ["LoginInput", "CreateUserInput"], "PasswordInput": ["PasswordInput"],
            "SetupInput": ["SetupInput"], "DatabaseInput": ["DatabaseInput"], "WorkspaceInput": ["WorkspaceInput"],
            "MemberInput": ["MemberInput"], "RoleInput": ["RoleInput"], "CreateResource": ["CreateResource"],
            "UpdateResource": ["UpdateResource"], "BranchInput": ["BranchInput"], "BudgetInput": ["BudgetInput"]},
        "src/engine.rs": {"ChatRequest": ["ChatRequest", "ImageChatRequest"]},
        "src/delivery.rs": {"SendRequest": ["SendRequest"]},
        "src/email_auth.rs": {"EmailInput": ["EmailInput"], "VerifyInput": ["EmailVerifyInput"], "ResetInput": ["EmailResetInput"]},
        "src/identity_config.rs": {"GoogleInput": ["GoogleSettingsInput"], "SmtpInput": ["SmtpSettingsInput"], "SettingsInput": ["AuthSettingsInput"]},
        "src/identity.rs": {"PasswordReauth": ["PasswordReauth"], "RegistrationInput": ["PasskeyRegistrationInput"],
            "RegistrationFinish": ["PasskeyFinishInput"], "AuthenticationFinish": ["PasskeyFinishInput"],
            "LoginInput": ["PasskeyLoginInput"], "RenameInput": ["PasskeyRenameInput"]},
        "src/identity/google.rs": {"StartInput": ["GoogleStartInput"], "UnlinkInput": ["GoogleUnlinkInput"]},
    }
    for source_path, names in groups.items():
        source = (ROOT / source_path).read_text()
        for rust_name, schema_names in names.items():
            pattern = r'(?:pub(?:\(\w+\))?\s+)?struct\s+' + re.escape(rust_name) + r'\s*\{(.*?)\n\}'
            match = re.search(pattern, source, re.S)
            if not match:
                raise ValueError(f"Request struct disappeared: {rust_name}")
            fields, optional = set(), set()
            default_pending = False
            for line in match.group(1).splitlines():
                if "#[serde(default" in line:
                    default_pending = True
                field = re.match(r'\s*(?:pub\s+)?(\w+):\s*(.+),\s*$', line)
                if field:
                    name, kind = field.groups()
                    fields.add(name)
                    if kind.startswith("Option<") or default_pending:
                        optional.add(name)
                    default_pending = False
            before = source[max(0, match.start() - 180):match.start()]
            last_derive = before.rfind("#[derive")
            closed = "deny_unknown_fields" in before[last_derive:]
            for schema_name in schema_names:
                schema = document["components"]["schemas"][schema_name]
                # The HTTP handlers split the shared Rust DTO: ordinary chat
                # rejects images and the dedicated route requires them.
                expected_fields = fields - {"images"} if schema_name == "ChatRequest" else fields
                required = fields - optional
                if schema_name == "ImageChatRequest":
                    required |= {"images"}
                if set(schema.get("properties", {})) != expected_fields:
                    raise ValueError(f"{rust_name}/{schema_name}: DTO fields differ")
                if set(schema.get("required", [])) != required:
                    raise ValueError(f"{rust_name}/{schema_name}: required/optional fields differ")
                if (schema.get("additionalProperties") is False) != closed:
                    raise ValueError(f"{rust_name}/{schema_name}: unknown-field behavior differs")
                checks += 1
    return checks


def validate(document, source):
    assert document["openapi"] == "3.1.0"
    assert document["jsonSchemaDialect"] == "https://json-schema.org/draft/2020-12/schema"
    assert document["info"]["title"] and document["info"]["version"]
    assert document["servers"][0]["url"] == "/"
    references = 0
    for location, value in walk(document):
        if "$ref" in value:
            resolve(document, value)
            references += 1
        if "nullable" in value:
            raise ValueError(location + ": OpenAPI 3.0 nullable keyword is not used in this 3.1 document")
    expected = actual_routes(source)
    registered, operation_ids, examples = {}, set(), 0
    schemes = document["components"]["securitySchemes"]
    assert schemes["sessionCookie"]["name"] == "rstrbot_session"
    assert schemes["csrfHeader"]["name"] == "X-RstrBot-Request"
    for path, item in document["paths"].items():
        assert path.startswith("/")
        for method, operation in item.items():
            if method not in METHODS:
                continue
            key = (path, method)
            handler_source_path, handler = operation["x-handler"].rsplit("::", 1)
            registered[key] = operation["x-handler"]
            identifier = operation["operationId"]
            if identifier in operation_ids:
                raise ValueError("Duplicate operationId: " + identifier)
            operation_ids.add(identifier)
            assert operation["summary"] and operation["description"]
            for alternative in operation.get("security", document.get("security", [])):
                assert set(alternative).issubset(schemes), (key, alternative)
            params = [resolve(document, p) for p in item.get("parameters", []) + operation.get("parameters", [])]
            param_keys = [(p["in"], p["name"]) for p in params]
            assert len(param_keys) == len(set(param_keys)), (key, "duplicate parameters")
            path_params = {p["name"] for p in params if p["in"] == "path"}
            assert path_params == set(re.findall(r"\{([^}]+)\}", path)), (key, "path parameters mismatch")
            assert all(p.get("required") is True for p in params if p["in"] == "path")
            assert all("schema" in p for p in params)
            if method in MUTATIONS and path.startswith("/api/"):
                assert ("header", "X-RstrBot-Request") in param_keys
                assert "x-csrf" in operation
            responses = operation["responses"]
            assert any(re.match(r"[23]\d\d$", status) for status in responses)
            if "204" in responses:
                assert "content" not in resolve(document, responses["204"])
            for status, response in responses.items():
                assert status == "default" or re.match(r"[1-5](?:\d\d|XX)$", status)
                response = resolve(document, response)
                assert response["description"]
            for location, container in [("request", operation.get("requestBody", {}))] + [(status, resolve(document, response)) for status, response in responses.items()]:
                if not container:
                    continue
                for media, payload in container.get("content", {}).items():
                    assert media == "application/json"
                    assert "schema" in payload
                    values = ([payload["example"]] if "example" in payload else []) + [entry["value"] for entry in payload.get("examples", {}).values()]
                    for index, example in enumerate(values):
                        validate_value(document, example, payload["schema"], f"{method.upper()} {path}/{location}/example/{index}")
                        examples += 1
            # Function return type independently checks the real 204 convention.
            handler_source = (ROOT / handler_source_path).read_text()
            match = re.search(r'async fn\s+' + re.escape(handler) + r'\s*\(', handler_source)
            assert match, (key, "handler missing")
            end = balanced_end(handler_source, handler_source.index("(", match.start()))
            signature = handler_source[end + 1:handler_source.index("{", end + 1)]
            if "ApiResult<StatusCode>" in signature:
                assert "204" in responses, (key, "actual no-content handler")
    if registered != expected:
        raise ValueError(f"Router coverage mismatch. Missing={set(expected)-set(registered)}, extra={set(registered)-set(expected)}, wrong handlers={[key for key in expected.keys() & registered.keys() if expected[key] != registered[key]]}")
    # The generic URL cannot select a JSON Schema branch by a path parameter;
    # verify each named example against the explicit kind/schema binding too.
    mappings = document["components"]["schemas"]["CreateResource"]["x-resource-input-schemas"]
    post = document["paths"]["/api/v1/workspaces/{wid}/resources/{kind}"]["post"]
    example_names = {"conversation": "conversations", "model": "models", "plugin": "plugins", "knowledge": "knowledge",
                     "memory": "memories", "schedule": "schedules", "route": "routes", "agent": "agents"}
    for name, entry in post["requestBody"]["content"]["application/json"]["examples"].items():
        validate_value(document, entry["value"]["data"], mappings[example_names[name]], "resource-kind-example/" + name)
    return {"registered_paths": len({path for path, method in expected}), "registered_operations": len(expected),
            "api_v1_operations": sum(path.startswith("/api/v1/") for path, method in expected),
            "health_operations": sum(path.startswith("/health/") for path, method in expected),
            "schema_count": len(document["components"]["schemas"]), "resolved_references": references,
            "validated_examples": examples, "request_schema_type_checks": dto_checks(document),
            "operation_ids_unique": True, "all_declared_router_methods_covered": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, default=ROOT / "docs/openapi.json")
    parser.add_argument("--output", type=Path)
    options = parser.parse_args()
    source_path = ROOT / "src/api.rs"
    report = {"checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "scope": "Static OpenAPI/router/DTO/reference/example checks; not native execution or a full external OpenAPI meta-schema validator.",
              "spec_sha256": hashlib.sha256(options.spec.read_bytes()).hexdigest(),
              "router_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest()}
    report["router_module_sha256"] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        for name in ["src/api.rs", "src/identity.rs", "src/identity/google.rs", "src/identity_config.rs", "src/email_auth.rs"]}
    try:
        report.update(validate(read_json(options.spec), source_path.read_text()))
        report["status"] = "passed"
    except (AssertionError, ValueError, KeyError, TypeError, RecursionError) as error:
        report.update(status="failed", error=str(error))
    encoded = json.dumps(report, indent=2) + "\n"
    if options.output:
        options.output.parent.mkdir(parents=True, exist_ok=True)
        options.output.write_text(encoded)
    print(encoded, end="")
    return int(report["status"] != "passed")


if __name__ == "__main__":
    sys.exit(main())
