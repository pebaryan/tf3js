import { describe, expect, it } from 'vitest';
import {
  ATTACHMENTS, EVA8_WEAPON, KRABER_WEAPON, PILOT_WEAPONS, R201_WEAPON, WEAPON_MUZZLES, WeaponManager,
  barrelAttachmentLength, cloneWeapon,
} from './weapons';

describe('cloneWeapon', () => {
  it('returns an independent copy whose attachments do not leak into the template', () => {
    const copy = cloneWeapon(R201_WEAPON);
    copy.attachments.magazine = ATTACHMENTS.extended_mag;
    expect(R201_WEAPON.attachments.magazine).toBeUndefined();
    expect(copy).not.toBe(R201_WEAPON);
    expect(copy.name).toBe(R201_WEAPON.name);
  });
});

describe('WeaponManager', () => {
  it('stores copies, so attaching never mutates the shared weapon definition', () => {
    const wm = new WeaponManager();
    wm.addWeapon(R201_WEAPON);
    wm.attach(0, ATTACHMENTS.extended_mag);
    expect(R201_WEAPON.attachments.magazine).toBeUndefined();
    expect(wm.getCurrentWeapon()!.attachments.magazine?.id).toBe('extended_mag');
  });

  it('starts each weapon with a full magazine', () => {
    const wm = new WeaponManager();
    wm.addWeapon(R201_WEAPON);
    expect(wm.getCurrentAmmo()).toBe(R201_WEAPON.magazineSize);
  });

  it('consumes ammo and refuses to fire an empty magazine', () => {
    const wm = new WeaponManager();
    wm.addWeapon(KRABER_WEAPON);
    for (let i = 0; i < KRABER_WEAPON.magazineSize; i++) expect(wm.consumeAmmo()).toBe(true);
    expect(wm.getCurrentAmmo()).toBe(0);
    expect(wm.consumeAmmo()).toBe(false);
  });

  it('reloads to the effective magazine size after the reload time', () => {
    const wm = new WeaponManager();
    wm.addWeapon(R201_WEAPON);
    wm.attach(0, ATTACHMENTS.extended_mag);
    wm.consumeAmmo(5);
    expect(wm.startReload()).toBe(true);
    expect(wm.consumeAmmo()).toBe(false); // can't fire while reloading
    expect(wm.updateReload(R201_WEAPON.reloadTime - 1)).toBe(false);
    expect(wm.updateReload(1)).toBe(true);
    expect(wm.getCurrentAmmo()).toBe(R201_WEAPON.magazineSize + 8);
  });

  it('does not start a reload with a full magazine', () => {
    const wm = new WeaponManager();
    wm.addWeapon(R201_WEAPON);
    expect(wm.startReload()).toBe(false);
  });

  it('applies the quick-reload attachment to reload time', () => {
    const wm = new WeaponManager();
    const weapon = wm.addWeapon(R201_WEAPON);
    wm.attach(0, ATTACHMENTS.fast_mag);
    expect(wm.getEffectiveReloadTime(weapon)).toBeCloseTo(R201_WEAPON.reloadTime * 0.7);
  });

  it('applies barrel damage and recoil modifiers', () => {
    const wm = new WeaponManager();
    const weapon = wm.addWeapon(R201_WEAPON);
    wm.attach(0, ATTACHMENTS.suppressor);
    expect(wm.getEffectiveDamage(weapon)).toBeCloseTo(R201_WEAPON.damage * 0.9);
    expect(wm.getEffectiveRecoil(weapon).y).toBeCloseTo(R201_WEAPON.recoil.y * 1.1);
  });

  it('cancels an in-progress reload when switching weapons', () => {
    const wm = new WeaponManager();
    wm.addWeapon(R201_WEAPON);
    wm.addWeapon(EVA8_WEAPON);
    wm.consumeAmmo();
    wm.startReload();
    wm.switchTo(1);
    expect(wm.isReloading()).toBe(false);
  });

  it('replaceWeapon returns the dropped weapon and refills ammo for the new one', () => {
    const wm = new WeaponManager();
    wm.addWeapon(R201_WEAPON);
    wm.consumeAmmo(10);
    const dropped = wm.replaceWeapon(0, EVA8_WEAPON);
    expect(dropped?.name).toBe('R-201');
    expect(wm.getCurrentWeapon()!.name).toBe('EVA-8');
    expect(wm.getCurrentAmmo()).toBe(EVA8_WEAPON.magazineSize);
  });

  it('cycles through weapons with next/prev', () => {
    const wm = new WeaponManager();
    wm.addWeapon(R201_WEAPON);
    wm.addWeapon(EVA8_WEAPON);
    expect(wm.nextWeapon()!.name).toBe('EVA-8');
    expect(wm.nextWeapon()!.name).toBe('R-201');
    expect(wm.prevWeapon()!.name).toBe('EVA-8');
  });
});


describe('weapon muzzles', () => {
  it('defines a forward-facing muzzle for every pilot weapon', () => {
    for (const weapon of PILOT_WEAPONS) {
      const muzzle = WEAPON_MUZZLES[weapon.name];
      expect(muzzle, weapon.name).toBeDefined();
      expect(muzzle.z, weapon.name).toBeLessThan(-0.05);
    }
  });

  it('extends the muzzle for barrel attachments only', () => {
    expect(barrelAttachmentLength('suppressor')).toBeGreaterThan(0);
    expect(barrelAttachmentLength('stabilizer')).toBeGreaterThan(0);
    expect(barrelAttachmentLength(undefined)).toBe(0);
    expect(barrelAttachmentLength('extended_mag')).toBe(0);
  });
});
