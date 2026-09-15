use sha2::{Digest, Sha256};

pub fn namespace(package: &str, path: &str, source: &str) -> Result<String, &'static str> {
    let path = crate::normalise_path(path)?;
    let mut digest = Sha256::new();
    digest.update(b"hypergraft-template-identity\0");
    for bytes in [
        b"1".as_slice(),
        package.as_bytes(),
        path.as_bytes(),
        source.as_bytes(),
    ] {
        let length =
            u32::try_from(bytes.len()).map_err(|_| "identity frame exceeds its length bound")?;
        digest.update(length.to_be_bytes());
        digest.update(bytes);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub fn valid_authored(value: &str) -> bool {
    value.len() <= 1024
        && value.strip_prefix("u:").is_some_and(|hex| {
            !hex.is_empty()
                && hex.len().is_multiple_of(2)
                && hex
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}
