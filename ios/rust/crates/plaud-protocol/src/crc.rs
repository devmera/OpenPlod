//! CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no final XOR),
//! as used by `tnt_get_crc` in the SDK's native lib for file-tail checks.

pub fn crc16_ccitt_false(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_check_value() {
        // The catalogued check value for CRC-16/CCITT-FALSE over "123456789".
        assert_eq!(crc16_ccitt_false(b"123456789"), 0x29B1);
    }
}
