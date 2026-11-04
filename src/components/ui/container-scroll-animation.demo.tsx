'use client';
import React from 'react';
import { ContainerScroll } from '@/components/ui/container-scroll-animation';
import Image from 'next/image';

/**
 * Reference demo for `ContainerScroll` — a copy of the published snippet, NOT
 * mounted on any route (it is a 60–80rem tall scroll section, which only makes
 * sense in a page's own flow). Keep it as the usage example and as the proof
 * the component renders with its original look when no overrides are passed.
 *
 * One change from the published snippet: the screenshot is the app's own
 * `/landing/img/screenshot-1.png` (same-origin) instead of the Aceternity CDN
 * URL. `next/image` refuses a remote host until it is allow-listed in
 * `next.config.ts` → `images.remotePatterns`, and adding a remote host to that
 * config for a demo is a change with blast radius beyond this file.
 */
export function HeroScrollDemo() {
  return (
    <div className="flex flex-col overflow-hidden pt-[1000px] pb-[500px]">
      <ContainerScroll
        titleComponent={
          <>
            <h1 className="text-4xl font-semibold text-black dark:text-white">
              Unleash the power of <br />
              <span className="mt-1 text-4xl leading-none font-bold md:text-[6rem]">
                Scroll Animations
              </span>
            </h1>
          </>
        }
      >
        <Image
          src="/landing/img/screenshot-1.png"
          alt="Ashwini Innovations inbox screenshot"
          height={720}
          width={1400}
          className="mx-auto h-full rounded-2xl object-cover object-left-top"
          draggable={false}
        />
      </ContainerScroll>
    </div>
  );
}
