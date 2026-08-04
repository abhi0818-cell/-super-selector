/**
 * Renders a booster icon that may be a plain emoji OR a data-URI image.
 *
 * The domestic-double booster's icon/label used to be hardcoded per app
 * ("US Double" 🇺🇸) — now it comes from the active tournament's
 * domestic_icon (see teamStore.RULES.domesticIcon / boosterStore's
 * getDomesticBoosterMeta()). Some tournaments set a data:image/... URI
 * instead of an emoji (e.g. CPL's West Indies crest — there's no single
 * accurate Unicode flag for "Caribbean"/"West Indies", since it's a
 * multi-nation team, not a country). A plain <Text> can't render that, so
 * this picks <Image> vs <Text> based on the icon string, mirroring web's
 * iconHtml() helper in index.html.
 */
import React from 'react';
import { Text, Image, TextStyle, ImageStyle } from 'react-native';

interface BoosterIconProps {
  icon: string | undefined | null;
  /** Font size to use for emoji text, and side length (px) for image icons. */
  size: number;
  style?: TextStyle;
  imageStyle?: ImageStyle;
}

export default function BoosterIcon({ icon, size, style, imageStyle }: BoosterIconProps) {
  if (!icon) return null;
  if (icon.indexOf('data:') === 0) {
    return (
      <Image
        source={{ uri: icon }}
        style={[{ width: size, height: size, borderRadius: 2 }, imageStyle]}
        resizeMode="cover"
      />
    );
  }
  return <Text style={[{ fontSize: size }, style]}>{icon}</Text>;
}
